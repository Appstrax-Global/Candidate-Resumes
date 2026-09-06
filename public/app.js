document.addEventListener('DOMContentLoaded', () => {
  // ─── DOM Elements ───
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const fileListSection = document.getElementById('fileListSection');
  const fileList = document.getElementById('fileList');
  const clearFilesBtn = document.getElementById('clearFilesBtn');
  const statusCard = document.getElementById('statusCard');
  const statusFileName = document.getElementById('statusFileName');
  const statusFileSize = document.getElementById('statusFileSize');
  const progressBar = document.getElementById('progressBar');
  const statusText = document.getElementById('statusText');
  const progressPercentage = document.getElementById('progressPercentage');
  const cancelBtn = document.getElementById('cancelBtn');
  const resultsPanel = document.getElementById('resultsPanel');
  const resultsStatusBadge = document.getElementById('resultsStatusBadge');
  const resTotalFiles = document.getElementById('resTotalFiles');
  const resTotalChars = document.getElementById('resTotalChars');
  const fileResultSelect = document.getElementById('fileResultSelect');
  const extractedText = document.getElementById('extractedText');
  const copyBtn = document.getElementById('copyBtn');
  const submitWebhookBtn = document.getElementById('submitWebhookBtn');
  const submitStatusMsg = document.getElementById('submitStatusMsg');
  const errorToast = document.getElementById('errorToast');
  const errorText = document.getElementById('errorText');

  let activeXhr = null;
  let selectedFiles = [];       // Files the user has selected (File objects)
  let extractionResults = [];   // Server response results after upload

  // ─── Drop zone click → open file picker ───
  dropZone.addEventListener('click', () => fileInput.click());

  // ─── File input change ───
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      addFiles(Array.from(e.target.files));
    }
  });

  // ─── Drag and drop ───
  ['dragenter', 'dragover'].forEach(evt => {
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('dragover'); }, false);
  });
  ['dragleave', 'drop'].forEach(evt => {
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('dragover'); }, false);
  });
  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length > 0) {
      addFiles(Array.from(e.dataTransfer.files));
    }
  });

  // ─── Clear All button ───
  clearFilesBtn.addEventListener('click', () => {
    selectedFiles = [];
    extractionResults = [];
    renderFileList();
    resultsPanel.style.display = 'none';
    fileListSection.style.display = 'none';
    hideError();
    submitStatusMsg.style.display = 'none';
    fileInput.value = '';
  });

  // ─── Cancel upload ───
  cancelBtn.addEventListener('click', () => {
    if (activeXhr) {
      activeXhr.abort();
      activeXhr = null;
      statusCard.style.display = 'none';
      showError('Upload cancelled.');
    }
  });

  // ─── Preview dropdown change ───
  fileResultSelect.addEventListener('change', (e) => {
    displayExtractedFile(parseInt(e.target.value));
  });

  // ─── Copy button ───
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(extractedText.innerText).then(() => {
      const orig = copyBtn.innerHTML;
      copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
      setTimeout(() => { copyBtn.innerHTML = orig; }, 2000);
    }).catch(err => console.error('Copy failed:', err));
  });

  // ─── SUBMIT TO WEBHOOK ───
  submitWebhookBtn.addEventListener('click', () => {
    const successItems = extractionResults.filter(r => r.success);
    if (successItems.length === 0) {
      showSubmitStatus('No successfully extracted documents to submit.', 'error');
      return;
    }

    // Decide payload: use DB IDs if available, otherwise send documents directly
    const hasIds = successItems.every(r => r.id);
    let bodyPayload;
    if (hasIds) {
      bodyPayload = { ids: successItems.map(r => r.id) };
    } else {
      bodyPayload = {
        documents: successItems.map(r => ({
          candidate_id: r.candidate_id,
          filename: r.filename,
          pages: r.pages,
          characters: r.characters,
          text: r.text,
          email: r.email
        }))
      };
    }

    submitWebhookBtn.disabled = true;
    submitWebhookBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Submitting...';
    showSubmitStatus('Sending extracted text to n8n webhook...', 'info');

    fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload)
    })
    .then(res => res.json())
    .then(data => {
      submitWebhookBtn.disabled = false;
      submitWebhookBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit to Webhook';
      if (data.success) {
        showSubmitStatus(`All ${successItems.length} document(s) successfully sent to webhook!`, 'success');
      } else {
        const failedCount = (data.results || []).filter(r => !r.success).length;
        showSubmitStatus(`Completed with ${failedCount} failure(s). Check server logs.`, 'error');
      }
    })
    .catch(err => {
      submitWebhookBtn.disabled = false;
      submitWebhookBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit to Webhook';
      showSubmitStatus(`Network error: ${err.message}`, 'error');
    });
  });

  // ═══════════════════════════════════════════
  //  HELPER FUNCTIONS
  // ═══════════════════════════════════════════

  function addFiles(newFiles) {
    hideError();
    const allowedExts = ['pdf', 'docx'];
    const maxSize = 20 * 1024 * 1024;

    for (const file of newFiles) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!allowedExts.includes(ext)) {
        showError(`Skipped "${file.name}" — only PDF and DOCX are allowed.`);
        continue;
      }
      if (file.size > maxSize) {
        showError(`Skipped "${file.name}" — exceeds 20 MB limit.`);
        continue;
      }
      // Avoid duplicates by name+size
      const alreadyAdded = selectedFiles.some(f => f.name === file.name && f.size === file.size);
      if (!alreadyAdded) {
        selectedFiles.push(file);
      }
    }

    if (selectedFiles.length > 0) {
      fileListSection.style.display = 'flex';
      renderFileList();
      // Auto-upload immediately
      uploadFiles();
    }
    fileInput.value = '';
  }

  function renderFileList() {
    fileList.innerHTML = '';
    selectedFiles.forEach((file, idx) => {
      const ext = file.name.split('.').pop().toLowerCase();
      const iconClass = ext === 'pdf' ? 'fa-regular fa-file-pdf icon-pdf' : 'fa-regular fa-file-word icon-docx';

      // Determine status from extraction results
      let statusBadge = '<span class="file-status-badge pending">Pending</span>';
      let candIdDisplay = '';
      if (extractionResults.length > 0 && extractionResults[idx]) {
        const item = extractionResults[idx];
        statusBadge = item.success
          ? '<span class="file-status-badge success">Extracted</span>'
          : '<span class="file-status-badge failed">Failed</span>';
        if (item.success && item.candidate_id) {
          candIdDisplay = `<span style="font-family: monospace; background: rgba(255,255,255,0.06); padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.78rem; font-weight: 600; color: var(--accent);">${item.candidate_id}</span>`;
        }
      }

      const li = document.createElement('li');
      li.className = 'file-list-item';
      li.innerHTML = `
        <div class="file-name">
          <i class="${iconClass}"></i>
          <span>${file.name}</span>
        </div>
        <div style="display:flex;align-items:center;gap:0.75rem;">
          ${candIdDisplay}
          <span class="file-size">${formatBytes(file.size)}</span>
          ${statusBadge}
        </div>
      `;
      fileList.appendChild(li);
    });
  }

  function uploadFiles() {
    extractionResults = [];
    resultsPanel.style.display = 'none';
    submitStatusMsg.style.display = 'none';

    const totalSize = selectedFiles.reduce((s, f) => s + f.size, 0);
    statusFileName.innerText = selectedFiles.length === 1 ? selectedFiles[0].name : `${selectedFiles.length} files`;
    statusFileSize.innerText = formatBytes(totalSize);
    statusCard.style.display = 'flex';
    statusText.innerText = 'Uploading files...';
    progressBar.style.width = '0%';
    progressPercentage.innerText = '0%';

    const formData = new FormData();
    selectedFiles.forEach(f => formData.append('documents', f));

    const xhr = new XMLHttpRequest();
    activeXhr = xhr;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressBar.style.width = pct + '%';
        progressPercentage.innerText = pct + '%';
        statusText.innerText = pct === 100 ? 'Extracting text from documents...' : 'Uploading files...';
      }
    });

    xhr.addEventListener('load', function () {
      activeXhr = null;
      statusCard.style.display = 'none';

      let response;
      try {
        response = JSON.parse(this.responseText);
      } catch (err) {
        showError('Server returned an invalid response.');
        return;
      }

      if (response.results && Array.isArray(response.results)) {
        extractionResults = response.results;

        // Update file list badges
        renderFileList();

        // Build results panel
        const successResults = extractionResults.filter(r => r.success);
        const totalChars = successResults.reduce((s, r) => s + (r.characters || 0), 0);

        resTotalFiles.innerText = successResults.length;
        resTotalChars.innerText = totalChars.toLocaleString();

        if (successResults.length > 0) {
          resultsStatusBadge.innerHTML = '<i class="fa-solid fa-circle-check"></i> <span>Extracted</span>';
          resultsStatusBadge.style.background = 'rgba(16,185,129,0.1)';
          resultsStatusBadge.style.color = 'var(--success)';
          resultsStatusBadge.style.borderColor = 'rgba(16,185,129,0.2)';
        } else {
          resultsStatusBadge.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> <span>Failed</span>';
          resultsStatusBadge.style.background = 'rgba(239,68,68,0.1)';
          resultsStatusBadge.style.color = 'var(--error)';
          resultsStatusBadge.style.borderColor = 'rgba(239,68,68,0.2)';
        }

        // Populate preview dropdown
        fileResultSelect.innerHTML = '';
        extractionResults.forEach((item, i) => {
          const opt = document.createElement('option');
          opt.value = i;
          const displayLabel = item.success 
            ? `${item.candidate_id || ''} - ${item.filename} (✓)`
            : `${item.filename} (✗)`;
          opt.innerText = displayLabel;
          fileResultSelect.appendChild(opt);
        });

        // Show first file's text
        displayExtractedFile(0);
        resultsPanel.style.display = 'flex';

        if (!response.success) {
          showError('Some files failed extraction. Check the list above for details.');
        }
      } else {
        showError(response.error || 'Upload failed.');
      }
    });

    xhr.addEventListener('error', () => {
      activeXhr = null;
      statusCard.style.display = 'none';
      showError('A network error occurred. Please try again.');
    });

    xhr.addEventListener('abort', () => {
      activeXhr = null;
      statusCard.style.display = 'none';
    });

    xhr.open('POST', '/api/upload');
    xhr.send(formData);
  }

  function displayExtractedFile(index) {
    const item = extractionResults[index];
    if (!item) return;
    if (item.success) {
      extractedText.innerText = item.text || '(No text content extracted)';
    } else {
      extractedText.innerText = `Error: ${item.error || 'Failed to process this document.'}`;
    }
  }

  function showSubmitStatus(msg, type) {
    submitStatusMsg.innerText = msg;
    submitStatusMsg.className = 'submit-status-msg ' + type;
    submitStatusMsg.style.display = 'block';
  }

  function showError(msg) {
    errorText.innerText = msg;
    errorToast.style.display = 'flex';
  }

  function hideError() {
    errorToast.style.display = 'none';
  }

  function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024, dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
});
