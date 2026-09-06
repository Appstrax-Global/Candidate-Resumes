const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { detectFileType } = require('../utils/fileTypeDetector');
const { extractText } = require('../services/extractionService');
const { sendWebhook } = require('../services/webhookService');
const db = require('../config/database');

async function saveRecord(record) {
  try {
    const query = `
      INSERT INTO extractions (candidate_id, filename, pages, characters, text, status, webhook_status, error_message, email)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `;
    const values = [
      record.candidate_id || null,
      record.filename,
      record.pages || 0,
      record.characters || 0,
      record.text || null,
      record.status,
      record.webhook_status,
      record.error_message || null,
      record.email || null
    ];
    const res = await db.query(query, values);
    const id = res?.rows[0]?.id;
    logger.info(`Saved extraction record to Supabase with ID ${id} (candidate_id: ${record.candidate_id}) for: ${record.filename}`);
    return id;
  } catch (err) {
    logger.error(`Failed to save record to Supabase for ${record.filename}: ${err.message}`);
    return null;
  }
}

async function uploadDocument(req, res, next) {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'No files were uploaded.'
    });
  }

  // 1. Fetch current max candidate_id from database (or default to 1000)
  let maxNumber = 1000;
  try {
    const dbRes = await db.query("SELECT candidate_id FROM extractions WHERE candidate_id IS NOT NULL");
    if (dbRes && dbRes.rows.length > 0) {
      for (const row of dbRes.rows) {
        const match = String(row.candidate_id).match(/^C(\d+)$/);
        if (match) {
          const number = parseInt(match[1], 10);
          if (number > maxNumber) {
            maxNumber = number;
          }
        }
      }
    }
  } catch (err) {
    logger.error(`Failed to fetch max candidate_id from DB: ${err.message}`);
  }

  // 2. Pre-assign all candidate IDs synchronously before any async work begins.
  //    This ensures IDs are stable and unique even if parallel closures start
  //    at the same tick.
  const fileJobs = req.files.map((file) => {
    maxNumber++;
    return { file, candidateId: `C${maxNumber}` };
  });

  // 3. Process every file concurrently. Each job is a fully self-contained
  //    async closure: it owns its own cleanup flag and only cleans up inside
  //    a finally block that runs after the extraction promise has settled.
  //    No file's cleanup can be triggered by another file's completion.
  const settled = await Promise.allSettled(
    fileJobs.map(({ file, candidateId }) => processOneFile(file, candidateId))
  );

  // 4. Collect results in original order
  const results = settled.map((outcome) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    // processOneFile is designed to never reject — it catches internally and
    // returns a failure-shaped result. This branch is a safety net only.
    return {
      success: false,
      error: outcome.reason?.message || 'Unknown processing error'
    };
  });

  const overallSuccess = results.every((r) => r.success);
  return res.status(overallSuccess ? 200 : 207).json({ success: overallSuccess, results });
}

/**
 * Handles the complete lifecycle of a single uploaded file:
 *   detect → extract → save → cleanup
 *
 * Cleanup is guaranteed to run in a `finally` block — it can never fire
 * before extraction settles, and the `isProcessing` flag prevents any
 * external code path from triggering it early.
 *
 * On extraction failure, logs the file size at that exact moment via
 * fs.statSync to confirm whether the file was still intact on disk when
 * the parser touched it.
 *
 * @param {Express.Multer.File} file
 * @param {string} candidateId
 * @returns {Promise<object>} — always resolves (never rejects)
 */
async function processOneFile(file, candidateId) {
  const filePath = file.path;
  const originalName = file.originalname;

  // ── Processing guard ──────────────────────────────────────────────────────
  // Set to true the moment we start, false only after extraction fully settles
  // (inside finally). Any cleanup caller checks this flag before acting.
  let isProcessing = true;
  let fileDeleted = false;

  /**
   * Safe cleanup: only runs when isProcessing is false (i.e., after the
   * extraction promise has settled). The flag makes it impossible for a
   * concurrent code path to delete the file while parsing is in progress.
   */
  const cleanup = () => {
    if (isProcessing) {
      // Should never happen — cleanup() is only called from finally{} which
      // runs after isProcessing is set to false. Logged as a safety net.
      logger.warn(
        `cleanup() called while isProcessing=true for ${originalName} — skipping to prevent race.`
      );
      return;
    }
    if (fileDeleted) return;
    try {
      fs.unlinkSync(filePath);
      logger.info(`Cleaned up temporary file: ${filePath}`);
      fileDeleted = true;
    } catch (err) {
      logger.error(`Failed to delete temporary file ${filePath}: ${err.message}`);
    }
  };

  try {
    // ── Step 1: Magic-number detection ──────────────────────────────────────
    logger.info(`Performing magic-number verification for: ${originalName}`);
    const detectedType = await detectFileType(filePath);

    if (!detectedType || detectedType.ext === 'doc') {
      // Release the processing guard before cleanup (invalid file — no extract)
      isProcessing = false;
      cleanup();

      const isLegacyDoc = detectedType && detectedType.ext === 'doc';
      const errorMessage = isLegacyDoc 
        ? 'Legacy .doc files require a separate parser like word-extractor. Only DOCX is supported.'
        : 'Invalid file signature. Only actual PDF and DOCX files are allowed.';

      const recordId = await saveRecord({
        candidate_id: candidateId,
        filename: originalName,
        status: 'failed',
        webhook_status: 'not_sent',
        error_message: errorMessage
      });

      return {
        id: recordId,
        candidate_id: candidateId,
        filename: originalName,
        fileType: isLegacyDoc ? 'doc' : 'unknown',
        extractionMethod: 'none',
        text: '',
        success: false,
        warnings: [],
        error: errorMessage
      };
    }

    logger.info(`Magic-number check passed for ${originalName}. Detected: ${detectedType.ext}`);

    // ── Step 2: Text extraction ──────────────────────────────────────────────
    // extractText fully resolves before we do anything else with the file.
    let extraction;
    try {
      extraction = await extractText(filePath, detectedType.ext);
    } catch (extractionErr) {
      // ── Diagnostic: log file size at exact moment of failure ──────────────
      // This tells us definitively whether the file was still on disk and
      // intact when the parser tried to read it (rules out a cleanup race).
      let fileSizeAtFailure = 'unknown';
      try {
        const stat = fs.statSync(filePath);
        fileSizeAtFailure = `${stat.size} bytes`;
      } catch (statErr) {
        fileSizeAtFailure = `stat failed (${statErr.code}) — file may have been deleted before extraction finished`;
      }

      logger.error(
        `Extraction failed for ${originalName} ` +
        `[candidateId=${candidateId}, path=${filePath}, sizeAtFailure=${fileSizeAtFailure}]: ` +
        extractionErr.message,
        { stack: extractionErr.stack }
      );

      // Re-throw so the outer try/catch records the failure result
      throw extractionErr;
    }

    // ── Step 3: Save success record ─────────────────────────────────────────
    const recordId = await saveRecord({
      candidate_id: candidateId,
      filename: originalName,
      pages: extraction.pages,
      characters: extraction.characters,
      text: extraction.text,
      email: extraction.email,
      status: 'success',
      webhook_status: 'pending'
    });

    return {
      id: recordId,
      candidate_id: candidateId,
      filename: originalName,
      fileType: detectedType.ext,
      extractionMethod: extraction.extractionMethod || 'unknown',
      text: extraction.text,
      email: extraction.email,
      success: true,
      warnings: [],
      pages: extraction.pages,
      characters: extraction.characters
    };

  } catch (error) {
    // Save failure record (extraction error already logged above with size info)
    const recordId = await saveRecord({
      candidate_id: candidateId,
      filename: originalName,
      status: 'failed',
      webhook_status: 'not_sent',
      error_message: error.message
    });

    return {
      id: recordId,
      candidate_id: candidateId,
      filename: originalName,
      fileType: 'unknown',
      extractionMethod: 'none',
      text: '',
      success: false,
      warnings: [],
      error: error.message || 'Processing error'
    };

  } finally {
    // ── Guaranteed cleanup ───────────────────────────────────────────────────
    // This runs after the extraction promise has fully settled (success OR
    // failure). The isProcessing flag is dropped here — cleanup() checks it
    // before touching the file, so there is no window where a parallel path
    // can delete the file while the parser is still reading it.
    isProcessing = false;
    cleanup();
  }
}

/**
 * Handle manual webhook submission.
 * Sends ALL extracted documents as ONE single JSON payload to the webhook.
 * Supports two modes:
 *   1. { ids: [1, 2, 3] }        → looks up records in the DB
 *   2. { documents: [{...},...] } → sends payloads directly (DB offline fallback)
 */
async function submitWebhook(req, res, next) {
  const { ids, documents } = req.body;
  let docsToSend = [];

  // ── Mode 2: Direct payload (no DB needed) ──
  if (documents && Array.isArray(documents) && documents.length > 0) {
    docsToSend = documents.map(doc => ({
      candidate_id: doc.candidate_id || '',
      filename: doc.filename,
      pages: doc.pages || 0,
      characters: doc.characters || 0,
      text: doc.text || '',
      email: doc.email || ''
    }));
  }
  // ── Mode 1: DB-based lookup ──
  else if (ids && Array.isArray(ids) && ids.length > 0) {
    for (const id of ids) {
      try {
        const dbRes = await db.query('SELECT * FROM extractions WHERE id = $1', [id]);
        if (!dbRes || dbRes.rows.length === 0) {
          logger.warn(`submitWebhook: record ID ${id} not found in database, skipping.`);
          continue;
        }
        const record = dbRes.rows[0];
        if (record.status !== 'success') {
          logger.warn(`submitWebhook: record ID ${id} status is "${record.status}", skipping.`);
          continue;
        }
        docsToSend.push({
          candidate_id: record.candidate_id,
          filename: record.filename,
          pages: record.pages,
          characters: record.characters,
          text: record.text,
          email: record.email || null
        });
      } catch (err) {
        logger.error(`submitWebhook: error fetching ID ${id}: ${err.message}`);
      }
    }
  } else {
    return res.status(400).json({
      success: false,
      error: 'No extraction IDs or documents provided.'
    });
  }

  if (docsToSend.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'No valid documents to submit.'
    });
  }

  // ── Build ONE combined payload with all documents ──
  const combinedPayload = {
    total_files: docsToSend.length,
    total_characters: docsToSend.reduce((sum, d) => sum + d.characters, 0),
    timestamp: new Date().toISOString(),
    documents: docsToSend
  };

  logger.info(`Sending ${docsToSend.length} document(s) to webhook as a single payload...`);
  const webhookSuccess = await sendWebhook(combinedPayload);

  // Update DB statuses if using IDs mode
  if (ids && Array.isArray(ids)) {
    const status = webhookSuccess ? 'delivered' : 'failed';
    for (const id of ids) {
      try {
        await db.query('UPDATE extractions SET webhook_status = $1 WHERE id = $2', [status, id]);
      } catch (dbErr) {
        logger.error(`Failed to update webhook_status for ID ${id}: ${dbErr.message}`);
      }
    }
  }

  if (webhookSuccess) {
    return res.status(200).json({
      success: true,
      message: `All ${docsToSend.length} document(s) sent to webhook successfully.`,
      results: docsToSend.map(d => ({ filename: d.filename, success: true }))
    });
  } else {
    return res.status(502).json({
      success: false,
      error: 'Webhook delivery failed after retries.',
      results: docsToSend.map(d => ({ filename: d.filename, success: false, error: 'Webhook failed' }))
    });
  }
}

async function getReviewQueue(req, res, next) {
  try {
    // Explicitly select all 14 known columns from the review_queue schema
    const query = `
      SELECT
        id,
        candidate_id,
        candidate_name,
        candidate_email,
        candidate_data,
        validation_report,
        unverified_fields,
        unverified_count,
        file_name,
        resume_content,
        upload_batch_id,
        status,
        reviewed_by,
        reviewed_at,
        created_at
      FROM review_queue
      ORDER BY created_at DESC
    `;
    const dbRes = await db.query(query);
    return res.status(200).json({
      success: true,
      data: dbRes ? dbRes.rows : []
    });
  } catch (err) {
    logger.error(`Error fetching review queue: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: `Failed to fetch review queue: ${err.message}`
    });
  }
}

async function updateReviewStatus(req, res, next) {
  const { id } = req.params;
  const { status, reviewed_by } = req.body;
  if (!status) {
    return res.status(400).json({ success: false, error: 'Status is required.' });
  }
  try {
    const query = `
      UPDATE review_queue
      SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING id, status, reviewed_by, reviewed_at
    `;
    const dbRes = await db.query(query, [status, reviewed_by || null, id]);
    if (!dbRes || dbRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: `Record ${id} not found.` });
    }
    return res.status(200).json({ success: true, data: dbRes.rows[0] });
  } catch (err) {
    logger.error(`Error updating review status: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Save recruiter edits: merges changed fields back into candidate_data jsonb.
 * Body: { changes: { field_path: new_value, ... }, reviewed_by: string }
 * field_path examples: "current_company", "skills.0", "phone"
 */
async function saveReviewChanges(req, res, next) {
  const { id } = req.params;
  const { changes, reviewed_by } = req.body;

  if (!changes || typeof changes !== 'object') {
    return res.status(400).json({ success: false, error: 'changes object is required.' });
  }

  try {
    // Fetch current candidate_data
    const fetchRes = await db.query('SELECT candidate_data FROM review_queue WHERE id = $1', [id]);
    if (!fetchRes || fetchRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: `Record ${id} not found.` });
    }

    let candData = fetchRes.rows[0].candidate_data || {};
    if (typeof candData === 'string') candData = JSON.parse(candData);

    // Apply each changed field (top-level key only for now)
    for (const [key, value] of Object.entries(changes)) {
      candData[key] = value;
    }

    const updateQuery = `
      UPDATE review_queue
      SET candidate_data = $1::jsonb,
          reviewed_by = $2,
          reviewed_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING id, candidate_data, status, reviewed_by, reviewed_at
    `;
    const updateRes = await db.query(updateQuery, [JSON.stringify(candData), reviewed_by || 'recruiter', id]);

    logger.info(`Saved changes for review_queue item ${id}`);
    return res.status(200).json({ success: true, data: updateRes.rows[0] });
  } catch (err) {
    logger.error(`Error saving review changes: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Approve review: saves edits and sets status → 'corrected'
 * Body: { changes: { ... }, reviewed_by: string }
 */
async function approveReview(req, res, next) {
  const { id } = req.params;
  const { changes, reviewed_by } = req.body;

  try {
    // Fetch current candidate_data
    const fetchRes = await db.query('SELECT candidate_data FROM review_queue WHERE id = $1', [id]);
    if (!fetchRes || fetchRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: `Record ${id} not found.` });
    }

    let candData = fetchRes.rows[0].candidate_data || {};
    if (typeof candData === 'string') candData = JSON.parse(candData);

    // Apply any edits
    if (changes && typeof changes === 'object') {
      for (const [key, value] of Object.entries(changes)) {
        candData[key] = value;
      }
    }

    const updateQuery = `
      UPDATE review_queue
      SET status = 'corrected',
          candidate_data = $1::jsonb,
          reviewed_by = $2,
          reviewed_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING id, status, candidate_data, reviewed_by, reviewed_at
    `;
    const updateRes = await db.query(updateQuery, [JSON.stringify(candData), reviewed_by || 'recruiter', id]);

    logger.info(`Approved review_queue item ${id} → status=corrected`);
    return res.status(200).json({ success: true, data: updateRes.rows[0] });
  } catch (err) {
    logger.error(`Error approving review: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Reject review: sets status → 'rejected'
 * Body: { reviewed_by: string }
 */
async function rejectReview(req, res, next) {
  const { id } = req.params;
  const { reviewed_by } = req.body;

  try {
    const updateQuery = `
      UPDATE review_queue
      SET status = 'rejected',
          reviewed_by = $1,
          reviewed_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id, status, reviewed_by, reviewed_at
    `;
    const updateRes = await db.query(updateQuery, [reviewed_by || 'recruiter', id]);
    if (!updateRes || updateRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: `Record ${id} not found.` });
    }

    logger.info(`Rejected review_queue item ${id}`);
    return res.status(200).json({ success: true, data: updateRes.rows[0] });
  } catch (err) {
    logger.error(`Error rejecting review: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  uploadDocument,
  submitWebhook,
  getReviewQueue,
  updateReviewStatus,
  saveReviewChanges,
  approveReview,
  rejectReview
};
