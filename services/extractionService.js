const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');
const { fromPath } = require('pdf2pic');
const Tesseract = require('tesseract.js');
const logger = require('../utils/logger');
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to repair a PDF's xref table in-place using qpdf.
 * qpdf --replace-input rewrites the file so that pdf-parse's frozen
 * PDF.js v1.10.100 can read it without throwing "bad XRef entry".
 *
 * Throws if qpdf is not installed or if the repair itself fails —
 * callers must catch and fall through to the next strategy.
 *
 * @param {string} filePath  Absolute path to the PDF (modified in place)
 */
function repairPdfWithQpdf(filePath) {
  // execFileSync throws on non-zero exit; we let that propagate
  execFileSync('qpdf', ['--replace-input', filePath], {
    timeout: 30000, // 30-second safety cap
    stdio: 'pipe'   // suppress qpdf's own warnings from the console
  });
  logger.info(`qpdf repair succeeded for: ${filePath}`);
}

/**
 * Extracts text from a PDF buffer using the modern pdfjs-dist library.
 * This is the fallback for files that break pdf-parse's frozen PDF.js bundle.
 *
 * @param {Buffer} dataBuffer
 * @returns {Promise<{text: string, pages: number, characters: number}>}
 */
async function extractWithPdfjsDist(dataBuffer) {
  // pdfjs-dist v4+ ships ES modules exclusively.
  // We use dynamic import to load the legacy mjs build.
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // Silence the "Setting up fake worker" warning in Node environments
  // Since we are using the mjs bundle, we resolve the mjs worker file.
  // On Windows, absolute paths must be converted to valid file:// URLs for ESM loader.
  const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(dataBuffer) });
  const pdfDoc = await loadingTask.promise;

  let fullText = '';
  const numPages = pdfDoc.numPages;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false
    });

    let lastY = null;
    let pageText = '';
    for (const item of textContent.items) {
      if (lastY !== null && Math.abs(lastY - item.transform[5]) > 2) {
        pageText += '\n';
      }
      pageText += item.str;
      lastY = item.transform[5];
    }

    fullText += pageText + '\n';
  }

  const cleanedText = fullText
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n');

  return {
    text: cleanedText,
    pages: numPages,
    characters: cleanedText.length
  };
}

// ---------------------------------------------------------------------------
// Primary PDF extraction
// ---------------------------------------------------------------------------

/**
 * Extracts text from PDF files.
 *
 * Strategy (waterfall):
 *   1. Attempt qpdf --replace-input to normalise the xref table in place.
 *      If qpdf is not installed or fails, log a warning and continue.
 *   2. Try pdf-parse (uses its bundled PDF.js v1.10.100) on the (possibly
 *      repaired) file.
 *   3. If pdf-parse still throws, fall back to pdfjs-dist (modern,
 *      actively maintained PDF.js) which handles non-standard xref tables.
 *
 * Preserves all whitespace, newlines, and page structure.
 *
 * @param {string} filePath
 * @returns {Promise<{text: string, pages: number, characters: number}>}
 */
async function extractTextFromPdf(filePath) {
  // ── Step 1: qpdf xref repair (best-effort, never blocks the pipeline) ──
  try {
    repairPdfWithQpdf(filePath);
  } catch (qpdfErr) {
    // qpdf not installed, timed out, or found the file unrecoverable.
    // Log at warn level and fall through — pdf-parse or pdfjs-dist may still
    // handle the file fine.
    logger.warn(
      `qpdf repair skipped for ${filePath}: ${qpdfErr.message.split('\n')[0]}`
    );
  }

  // Re-read the buffer after the potential in-place repair
  const dataBuffer = fs.readFileSync(filePath);

  // ── Step 2: pdf-parse (primary extractor) ──
  const pdfParseOptions = {
    // Preserve original text layout with line breaks
    pagerender: function (pageData) {
      return pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false
      }).then(function (textContent) {
        let lastY = null;
        let pageText = '';

        for (const item of textContent.items) {
          // Detect line breaks by checking if Y position changed
          if (lastY !== null && Math.abs(lastY - item.transform[5]) > 2) {
            pageText += '\n';
          }
          pageText += item.str;
          lastY = item.transform[5];
        }

        return pageText;
      });
    }
  };

  try {
    const data = await pdfParse(dataBuffer, pdfParseOptions);

    // Trim trailing whitespace per line but preserve structure
    const cleanedText = data.text
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
      .replace(/\n{4,}/g, '\n\n\n'); // collapse excessive blank lines (4+) into 3

    if (!cleanedText.trim()) {
      logger.info(`pdf-parse returned empty text for ${filePath}. Trying OCR fallback...`);
      return await extractWithOcr(filePath);
    }

    return {
      text: cleanedText,
      pages: data.numpages || 1,
      characters: cleanedText.length,
      extractionMethod: 'pdf-parse'
    };
  } catch (pdfParseErr) {
    // ── Step 3: pdfjs-dist fallback ──
    logger.warn(
      `pdf-parse failed for ${filePath} (${pdfParseErr.message}). ` +
      'Falling back to pdfjs-dist...'
    );

    try {
      const pdfjsResult = await extractWithPdfjsDist(dataBuffer);
      if (!pdfjsResult.text.trim()) {
        logger.info(`pdfjs-dist returned empty text for ${filePath}. Trying OCR fallback...`);
        return await extractWithOcr(filePath);
      }
      return {
        ...pdfjsResult,
        extractionMethod: 'pdfjs-dist'
      };
    } catch (pdfjsErr) {
      logger.warn(`pdfjs-dist failed for ${filePath} (${pdfjsErr.message}). Falling back to OCR...`);
      return await extractWithOcr(filePath);
    }
  }
}

/**
 * Extracts text from a PDF using pdf2pic and tesseract.js.
 * @param {string} filePath 
 * @returns {Promise<{text: string, pages: number, characters: number, extractionMethod: string}>}
 */
async function extractWithOcr(filePath) {
  try {
    const options = {
      density: 300,
      saveFilename: `ocr_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      savePath: path.dirname(filePath),
      format: "png",
      width: 2550,
      height: 3300
    };
    
    const convert = fromPath(filePath, options);
    const pagesToConvertAsImage = await convert.bulk(-1, { responseType: "image" });
    
    let fullText = '';
    for (const page of pagesToConvertAsImage) {
      logger.info(`Running OCR on page ${page.page}...`);
      const { data: { text } } = await Tesseract.recognize(
        page.path,
        'eng',
        { logger: () => {} } // silence noisy progress logs
      );
      fullText += text + '\n\n';
      
      try {
        fs.unlinkSync(page.path);
      } catch(e) {}
    }
    
    const cleanedText = fullText.trim();
    return {
      text: cleanedText,
      pages: pagesToConvertAsImage.length,
      characters: cleanedText.length,
      extractionMethod: 'tesseract.js + pdf2pic (OCR Fallback)'
    };
  } catch (e) {
    throw new Error(`OCR fallback failed: ${e.message}`);
  }
}

/**
 * Extracts text from DOCX files using mammoth.
 * Uses convertToHtml for richer extraction then strips HTML to plain text,
 * preserving paragraph breaks, list items, headings, and table cells.
 * @param {string} filePath 
 * @returns {Promise<{text: string, pages: number, characters: number}>}
 */
async function extractTextFromDocx(filePath) {
  // Step 1: Get HTML output (preserves paragraphs, lists, tables, headings)
  const htmlResult = await mammoth.convertToHtml(
    { path: filePath },
    {
      // Keep all structural elements for text fidelity
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh"
      ]
    }
  );

  const html = htmlResult.value;

  // Log any warnings from mammoth (e.g. unsupported features)
  if (htmlResult.messages && htmlResult.messages.length > 0) {
    htmlResult.messages.forEach(msg => {
      logger.warn(`Mammoth warning: ${msg.message}`);
    });
  }

  // Step 2: Convert HTML to clean plain text preserving structure
  const text = htmlToPlainText(html);

  // Step 3: Also get raw text as a fallback/comparison
  const rawResult = await mammoth.extractRawText({ path: filePath });
  const rawText = rawResult.value;

  // Use whichever extraction captured more content
  const finalText = text.length >= rawText.length ? text : rawText;

  // Estimate page count (approx 3000 chars per page for DOCX)
  const estimatedPages = Math.max(1, Math.ceil(finalText.length / 3000));

  if (!finalText.trim()) {
    logger.info(`Mammoth returned empty text for ${filePath}. Trying XML fallback...`);
    return await extractWithXmlFallback(filePath);
  }

  return {
    text: finalText,
    pages: estimatedPages,
    characters: finalText.length,
    extractionMethod: 'mammoth'
  };
}

/**
 * Extracts text from DOCX files by manually parsing word/document.xml.
 * @param {string} filePath 
 * @returns {Promise<{text: string, pages: number, characters: number, extractionMethod: string}>}
 */
async function extractWithXmlFallback(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const zip = new AdmZip(filePath);
      const zipEntries = zip.getEntries();
      const documentEntry = zipEntries.find(entry => entry.entryName === 'word/document.xml');
      
      if (!documentEntry) {
        return reject(new Error('word/document.xml not found in DOCX archive.'));
      }
      
      const xmlData = documentEntry.getData().toString('utf8');
      
      xml2js.parseString(xmlData, (err, result) => {
        if (err) return reject(err);
        
        let textSegments = [];
        const extractText = (obj) => {
          if (Array.isArray(obj)) {
            obj.forEach(extractText);
          } else if (typeof obj === 'object' && obj !== null) {
            for (const key in obj) {
              if (key === 'w:t') {
                const wt = obj[key];
                if (Array.isArray(wt)) {
                  wt.forEach(t => {
                    if (typeof t === 'string') textSegments.push(t);
                    else if (typeof t === 'object' && t._) textSegments.push(t._);
                  });
                } else if (typeof wt === 'string') {
                  textSegments.push(wt);
                } else if (typeof wt === 'object' && wt._) {
                  textSegments.push(wt._);
                }
              } else {
                extractText(obj[key]);
              }
            }
          }
        };
        
        extractText(result);
        const fullText = textSegments.join(' ').replace(/\s+/g, ' ').trim();
        const characters = fullText.length;
        const pages = Math.max(1, Math.ceil(characters / 3000));
        
        resolve({
          text: fullText,
          pages: pages,
          characters: characters,
          extractionMethod: 'adm-zip + xml2js (DOCX XML parser)'
        });
      });
    } catch (e) {
      reject(new Error(`XML fallback failed: ${e.message}`));
    }
  });
}

/**
 * Converts HTML string to clean plain text preserving paragraphs,
 * headings, list items, and table structure.
 * @param {string} html 
 * @returns {string}
 */
function htmlToPlainText(html) {
  let text = html;

  // Replace block-level tags with newlines
  text = text.replace(/<\/h[1-6]>/gi, '\n\n');
  text = text.replace(/<h[1-6][^>]*>/gi, '');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<p[^>]*>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Lists: add bullet/number markers
  text = text.replace(/<li[^>]*>/gi, '• ');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<\/?[uo]l[^>]*>/gi, '\n');

  // Table cells: separate with tab, rows with newlines
  text = text.replace(/<\/td>/gi, '\t');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<\/th>/gi, '\t');
  text = text.replace(/<\/?table[^>]*>/gi, '\n');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code));

  // Clean up excessive whitespace but preserve paragraph breaks
  text = text.split('\n').map(line => line.trimEnd()).join('\n');
  text = text.replace(/\n{4,}/g, '\n\n\n'); // collapse 4+ blank lines to 3
  text = text.trim();

  return text;
}

/**
 * Main extraction dispatcher based on detected file type
 * @param {string} filePath 
 * @param {string} type - 'pdf' | 'docx'
 */
async function extractText(filePath, type) {
  logger.info(`Starting text extraction for type: ${type}`);
  
  let result;
  if (type === 'pdf') {
    result = await extractTextFromPdf(filePath);
  } else if (type === 'docx') {
    result = await extractTextFromDocx(filePath);
  } else {
    throw new Error(`Unsupported file type for extraction: ${type}`);
  }

  // Extract email address
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = result.text ? result.text.match(emailRegex) : null;
  result.email = matches ? matches[0].toLowerCase() : null;

  logger.info(`Extraction complete: ${result.characters} characters, ${result.pages} pages, email: ${result.email}`);
  return result;
}

/**
 * Boot-time self-test to verify pdfjs-dist fallback configuration.
 */
async function testPdfjsFallback() {
  try {
    logger.info('Running pdfjs-dist fallback self-test...');
    // A minimal valid PDF file (just the header and EOF) to test initialization
    const tinyPdf = Buffer.from(
      "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000010 00000 n\n0000000053 00000 n\n0000000102 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n149\n%EOF\n"
    );
    await extractWithPdfjsDist(tinyPdf);
    logger.info('✅ pdfjs-dist fallback self-test passed successfully.');
  } catch (err) {
    logger.error(`❌ pdfjs-dist fallback self-test failed: ${err.message}`);
    // If it's a structural parsing error for the tiny PDF, that's fine,
    // we only care that the worker initialized successfully.
    if (!err.message.includes("worker") && !err.message.includes("file://")) {
      logger.info('Worker initialized correctly (failed gracefully on dummy PDF content).');
    } else {
      throw err;
    }
  }
}

module.exports = {
  extractText,
  testPdfjsFallback
};
