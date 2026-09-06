document.addEventListener('DOMContentLoaded', () => {

  // ─── State ───────────────────────────────────────────────
  let allItems    = [];
  let selected    = null;        // current review_queue row
  let candData    = {};          // parsed candidate_data
  let valReport   = {};          // parsed validation_report
  let unverified  = [];          // parsed unverified_fields array
  let pendingEdits = {};         // { fieldKey: newValue }

  // ─── DOM refs ────────────────────────────────────────────
  const candidateList = document.getElementById('candidateList');
  const searchInput   = document.getElementById('searchInput');
  const statusFilter  = document.getElementById('statusFilter');
  const detailPanel   = document.getElementById('detailPanel');
  const toastEl       = document.getElementById('rqToast');
  const toastMsg      = document.getElementById('rqToastMsg');

  // ─── Boot ────────────────────────────────────────────────
  fetchQueue();

  // ════════════════════════════════════════════════════════
  //  1. FETCH & SIDEBAR
  // ════════════════════════════════════════════════════════
  function fetchQueue() {
    fetch('/api/review-queue')
      .then(r => r.json())
      .then(data => {
        if (data.success && Array.isArray(data.data)) {
          allItems = data.data;
          renderSidebar(allItems);
        } else {
          sidebarError('Failed to load review queue.');
        }
      })
      .catch(() => sidebarError('Cannot reach server.'));
  }

  function sidebarError(msg) {
    candidateList.innerHTML = `
      <div style="text-align:center;color:var(--error);padding:2rem;">
        <i class="fa-solid fa-circle-exclamation" style="font-size:1.5rem;margin-bottom:.5rem;display:block;"></i>
        <p style="font-size:.85rem;">${msg}</p>
      </div>`;
  }

  function renderSidebar(items) {
    candidateList.innerHTML = '';
    if (!items.length) {
      candidateList.innerHTML = `<p style="text-align:center;color:var(--text-secondary);font-size:.85rem;padding:2rem 0;">No candidates found.</p>`;
      return;
    }
    items.forEach(item => {
      const cnt   = item.unverified_count || 0;
      const flags = cnt > 0 ? `<span class="flag-badge">${cnt} flags</span>` : '';
      const div   = document.createElement('div');
      div.className = `cand-card${selected?.id === item.id ? ' active' : ''}`;
      div.innerHTML  = `
        <h4>${esc(item.candidate_name || 'Unknown')}</h4>
        <p>${esc(item.candidate_email || '—')}</p>
        <div class="cand-meta">
          <span class="status-pill ${item.status}">${(item.status || '').replace(/_/g,' ')}</span>
          ${flags}
        </div>`;
      div.addEventListener('click', () => {
        document.querySelectorAll('.cand-card').forEach(c => c.classList.remove('active'));
        div.classList.add('active');
        openCandidate(item);
      });
      candidateList.appendChild(div);
    });
  }

  // ── Filters
  function filteredItems() {
    const q  = searchInput.value.toLowerCase();
    const st = statusFilter.value;
    return allItems.filter(i => {
      const matchQ  = !q || (i.candidate_name||'').toLowerCase().includes(q) || (i.candidate_email||'').toLowerCase().includes(q);
      const matchSt = !st || i.status === st;
      return matchQ && matchSt;
    });
  }

  searchInput.addEventListener('input', () => renderSidebar(filteredItems()));
  statusFilter.addEventListener('change', () => renderSidebar(filteredItems()));

  // ════════════════════════════════════════════════════════
  //  2. OPEN CANDIDATE
  // ════════════════════════════════════════════════════════
  function openCandidate(item) {
    selected     = item;
    pendingEdits = {};

    // safe-parse JSON columns
    candData   = safeJson(item.candidate_data);
    valReport  = safeJson(item.validation_report);
    unverified = (() => {
      const raw = safeJson(item.unverified_fields, []);
      return Array.isArray(raw) ? raw : Object.values(raw);
    })();

    renderDetail();
  }

  // ════════════════════════════════════════════════════════
  //  3. RENDER DETAIL PANEL
  // ════════════════════════════════════════════════════════
  function renderDetail() {
    const c     = candData;
    const vr    = valReport;
    const unv   = unverified;
    const item  = selected;
    const sum   = vr.summary || {};
    const total = sum.total_fields_checked || 0;
    const verif = sum.total_verified || 0;
    const flagN = sum.total_flagged || item.unverified_count || 0;

    detailPanel.innerHTML = `
      <!-- ══ STICKY HEADER ══ -->
      <div class="detail-topbar">
        <div class="detail-topbar-row1">
          <div class="cand-headline">
            <h2>${esc(item.candidate_name || '—')}</h2>
            <div class="cand-headline-sub">
              ${item.candidate_id ? `<span><i class="fa-solid fa-id-badge"></i> ${esc(item.candidate_id)}</span>` : ''}
              <span><i class="fa-regular fa-envelope"></i> ${esc(item.candidate_email || '—')}</span>
              ${c.phone ? `<span><i class="fa-solid fa-phone"></i> ${esc(c.phone)}</span>` : ''}
              ${c.candidate_location ? `<span><i class="fa-solid fa-location-dot"></i> ${esc(c.candidate_location)}</span>` : ''}
              ${item.file_name ? `<span><i class="fa-regular fa-file-pdf"></i> ${esc(item.file_name)}</span>` : ''}
            </div>
          </div>
          <div class="topbar-actions">
            <span class="status-pill ${item.status}" style="padding:.3rem .8rem;font-size:.75rem;">${(item.status||'').replace(/_/g,' ')}</span>
          </div>
        </div>
        <!-- Stat strip -->
        <div class="stat-strip">
          <div class="stat-box"><i class="fa-solid fa-circle-check stat-box-icon ok"></i><div><div class="stat-box-label">Verified</div><div class="stat-box-value" style="color:var(--success);">${verif}</div></div></div>
          <div class="stat-box"><i class="fa-solid fa-triangle-exclamation stat-box-icon warn"></i><div><div class="stat-box-label">Needs Review</div><div class="stat-box-value" style="color:var(--warn);">${flagN}</div></div></div>
          <div class="stat-box"><i class="fa-solid fa-list-check stat-box-icon total"></i><div><div class="stat-box-label">Total Checked</div><div class="stat-box-value" style="color:var(--primary);">${total}</div></div></div>
        </div>
      </div>

      <!-- ══ SCROLLABLE BODY ══ -->
      <div class="detail-body" id="detailBody">
        ${renderFlagsSection(unv)}
        ${renderPersonalSection(c, unv)}
        ${renderProfessionalSection(c, unv)}
        ${renderSkillsSection(c, unv)}
        ${renderExperienceSection(c, unv)}
        ${renderEducationSection(c, vr)}
        ${renderProjectsSection(c, vr)}
        ${renderCertsSection(c, vr)}
        ${renderResumeSection(item)}
        ${renderValidationAccordion(vr)}
      </div>

      <!-- ══ ACTION FOOTER ══ -->
      <div class="detail-footer">
        <button class="btn btn-reject" id="btnReject"><i class="fa-solid fa-xmark"></i> Reject</button>
        <button class="btn btn-save"   id="btnSave"><i class="fa-solid fa-floppy-disk"></i> Save Changes</button>
        <button class="btn btn-approve" id="btnApprove"><i class="fa-solid fa-circle-check"></i> Approve &amp; Save</button>
      </div>
    `;

    // Attach input listeners
    detailPanel.querySelectorAll('.edit-input').forEach(inp => {
      inp.addEventListener('input', e => {
        pendingEdits[e.target.dataset.field] = e.target.value;
      });
    });

    // Action buttons
    document.getElementById('btnReject').addEventListener('click',  doReject);
    document.getElementById('btnSave').addEventListener('click',    doSave);
    document.getElementById('btnApprove').addEventListener('click', doApprove);

    // Accordion toggle
    detailPanel.querySelectorAll('.accordion-trigger').forEach(btn => {
      btn.addEventListener('click', () => {
        const body = btn.nextElementSibling;
        body.classList.toggle('open');
        const arrow = btn.querySelector('.acc-arrow');
        if (arrow) arrow.style.transform = body.classList.contains('open') ? 'rotate(180deg)' : '';
      });
    });
  }

  // ════════════════════════════════════════════════════════
  //  4. RENDER SECTIONS
  // ════════════════════════════════════════════════════════

  /** Core editability rule — driven entirely by unverified_fields */
  function isEditable(field, category) {
    return unverified.some(u =>
      u.field === field &&
      (!category || u.category === category) &&
      u.verified === false
    );
  }

  function fieldWidget(value, fieldKey, category) {
    if (isEditable(fieldKey, category)) {
      const u = unverified.find(u => u.field === fieldKey && (!category || u.category === category));
      return `
        <div class="field-unverified"><i class="fa-solid fa-triangle-exclamation"></i> Needs Review</div>
        ${u ? `<div class="flag-reason"><i class="fa-solid fa-circle-info" style="margin-top:.1rem;font-size:.7rem;"></i>${esc(u.reason||'')}</div>` : ''}
        <input class="edit-input" data-field="${esc(fieldKey)}" value="${esc(value||'')}" placeholder="Enter correct value…">`;
    }
    return `<div class="field-verified"><i class="fa-solid fa-circle-check"></i> ${esc(value||'—')}</div>`;
  }

  // ── 4a. Flags summary (top section)
  function renderFlagsSection(unv) {
    if (!unv.length) return '';
    const items = unv.map(u => `
      <div class="flag-item">
        <div class="flag-item-header">
          <i class="fa-solid fa-triangle-exclamation"></i>
          ${esc(u.category || 'General')}
        </div>
        <div class="flag-item-label">Field: <code style="color:var(--accent2);">${esc(u.field||'')}</code></div>
        <div class="flag-item-value">${esc(u.value||'')}</div>
        <div class="flag-reason"><i class="fa-solid fa-circle-info" style="font-size:.7rem;margin-top:.15rem;"></i> ${esc(u.reason||'')}</div>
        <input class="edit-input" data-field="${esc(u.field)}" value="${esc(u.value||'')}" placeholder="Enter correct value…">
      </div>`).join('<hr style="border-color:rgba(245,158,11,.1); margin:.5rem 0;">');

    return `
      <section>
        <div class="sec-title warn-title"><i class="fa-solid fa-triangle-exclamation"></i> ${unv.length} Field${unv.length>1?'s':''} Requiring Review</div>
        <div class="flag-block">${items}</div>
      </section>`;
  }

  // ── 4b. Personal Information
  function renderPersonalSection(c, unv) {
    const fields = [
      { label:'Candidate ID', key:'candidate_id',  val: c.candidate_id,  ro: true },
      { label:'First Name',   key:'candidate_fname', val: c.candidate_fname,  cat:'Contact & Location' },
      { label:'Last Name',    key:'candidate_lname', val: c.candidate_lname,  cat:'Contact & Location' },
      { label:'Email',        key:'candidate_email', val: c.candidate_email, cat:'Contact & Location' },
      { label:'Phone',        key:'phone',           val: c.phone,           cat:'Contact & Location' },
      { label:'Location',     key:'candidate_location', val: c.candidate_location, cat:'Contact & Location' },
    ];
    const rows = fields.map(f => `
      <tr>
        <td>${f.label}</td>
        <td>${f.ro ? `<span style="font-family:monospace;color:var(--accent2);">${esc(f.val||'—')} <i class="fa-solid fa-lock" style="font-size:.7rem;color:var(--text-secondary);"></i></span>`
                   : fieldWidget(f.val, f.key, f.cat)}
        </td>
      </tr>`).join('');
    return `
      <section>
        <div class="sec-title"><i class="fa-solid fa-user"></i> Personal Information</div>
        <table class="info-table">${rows}</table>
      </section>`;
  }

  // ── 4c. Professional Information
  function renderProfessionalSection(c, unv) {
    const fields = [
      { label:'Job Title',      key:'current_job_title', val:c.current_job_title, cat:'Employment' },
      { label:'Company',        key:'company',           val:c.current_company,   cat:'Employment' },
      { label:'Experience',     key:'years_of_experience', val: c.years_of_experience ? c.years_of_experience+' yrs' : '—', ro:true },
      { label:'Seniority',      key:'seniority',         val:c.seniority,         ro:true },
      { label:'Graduation Year',key:'graduation_year',   val:c.graduation_year,   ro:true },
    ];
    const rows = fields.map(f => `
      <tr>
        <td>${f.label}</td>
        <td>${f.ro ? `<span>${esc(f.val||'—')}</span>` : fieldWidget(f.val, f.key, f.cat)}</td>
      </tr>`).join('');
    return `
      <section>
        <div class="sec-title"><i class="fa-solid fa-briefcase"></i> Professional Information</div>
        <table class="info-table">${rows}</table>
      </section>`;
  }

  // ── 4d. Skills
  function renderSkillsSection(c, unv) {
    const primary   = Array.isArray(c.primary_skills)   ? c.primary_skills   : [];
    const secondary = Array.isArray(c.secondary_skills) ? c.secondary_skills : [];

    function skillChips(arr, category) {
      return arr.map(sk => {
        const editable = isEditable('skill', category) &&
          unverified.some(u => u.field==='skill' && u.value===sk && u.category===category);
        return `
          <div class="skill-chip ${editable ? 'unverified' : 'verified'}">
            ${editable
              ? `<input class="edit-input" data-field="skill:${esc(sk)}" value="${esc(sk)}" style="margin-top:0;">
                 <i class="fa-solid fa-triangle-exclamation" style="color:var(--warn);font-size:.75rem;"></i>`
              : `<span>${esc(sk)}</span><i class="fa-solid fa-circle-check" style="color:var(--success);font-size:.75rem;"></i>`}
          </div>`;
      }).join('');
    }

    return `
      <section>
        <div class="sec-title"><i class="fa-solid fa-code"></i> Skills</div>
        ${primary.length ? `<div style="margin-bottom:1rem;"><div style="font-size:.8rem;font-weight:700;color:var(--text-secondary);margin-bottom:.5rem;text-transform:uppercase;letter-spacing:.05em;">Primary</div><div class="skills-grid">${skillChips(primary,'Skills')}</div></div>` : ''}
        ${secondary.length ? `<div><div style="font-size:.8rem;font-weight:700;color:var(--text-secondary);margin-bottom:.5rem;text-transform:uppercase;letter-spacing:.05em;">Secondary</div><div class="skills-grid">${skillChips(secondary,'Skills')}</div></div>` : ''}
      </section>`;
  }

  // ── 4e. Work Experience
  function renderExperienceSection(c, unv) {
    const history = Array.isArray(c.employment_history) ? c.employment_history : [];
    if (!history.length) return '';
    const blocks = history.map(job => {
      const companyEditable = isEditable('company', 'Employment') &&
        unverified.some(u => u.field==='company' && u.value===job.company && u.category==='Employment');
      return `
        <div class="exp-block">
          <div class="exp-block-title">${esc(job.title||'')}</div>
          <div class="exp-block-sub">${esc(job.company||'')} · ${esc(job.location||'')} · ${esc(job.start_date||'')} – ${esc(job.end_date||'')}</div>
          <div class="exp-field-row">
            <div class="exp-field-label">Company</div>
            <div class="exp-field-val">${companyEditable
              ? `<div class="field-unverified"><i class="fa-solid fa-triangle-exclamation"></i> Needs Review</div>
                 <input class="edit-input" data-field="company:${esc(job.company)}" value="${esc(job.company||'')}">`
              : `<div class="field-verified"><i class="fa-solid fa-circle-check"></i> ${esc(job.company||'—')}</div>`}</div>
          </div>
          <div class="exp-field-row">
            <div class="exp-field-label">Job Title</div>
            <div class="exp-field-val"><div class="field-verified"><i class="fa-solid fa-circle-check"></i> ${esc(job.title||'—')}</div></div>
          </div>
          <div class="exp-field-row">
            <div class="exp-field-label">Location &amp; Dates</div>
            <div class="exp-field-val" style="color:var(--text-secondary);font-size:.82rem;">${esc(job.location||'')} · ${esc(job.start_date||'')} – ${esc(job.end_date||'')}</div>
          </div>
        </div>`;
    }).join('');
    return `
      <section>
        <div class="sec-title"><i class="fa-solid fa-building"></i> Work Experience</div>
        ${blocks}
      </section>`;
  }

  // ── 4f. Education
  function renderEducationSection(c, vr) {
    const checks = Array.isArray(vr.education_checks) ? vr.education_checks : [];
    if (!checks.length) return '';
    const blocks = checks.map(ed => `
      <div class="exp-block">
        <div class="exp-block-title">${esc(ed.degree||c.degree||'')}</div>
        <div class="exp-block-sub">${esc(ed.institution||c.institution||'')} · ${esc(c.field_of_study||'')} · ${esc(c.graduation_year||'')}</div>
        <div class="exp-field-row">
          <div class="exp-field-label">Degree</div>
          <div class="exp-field-val"><div class="${ed.degree_verified ? 'field-verified' : 'field-unverified'}"><i class="fa-solid fa-${ed.degree_verified ? 'circle-check' : 'triangle-exclamation'}"></i> ${esc(ed.degree||'—')}</div></div>
        </div>
        <div class="exp-field-row">
          <div class="exp-field-label">Institution</div>
          <div class="exp-field-val"><div class="${ed.institution_verified ? 'field-verified' : 'field-unverified'}"><i class="fa-solid fa-${ed.institution_verified ? 'circle-check' : 'triangle-exclamation'}"></i> ${esc(ed.institution||'—')}</div></div>
        </div>
      </div>`).join('');
    return `
      <section>
        <div class="sec-title"><i class="fa-solid fa-graduation-cap"></i> Education</div>
        ${blocks}
      </section>`;
  }

  // ── 4g. Projects
  function renderProjectsSection(c, vr) {
    const projects = Array.isArray(c.projects) ? c.projects : [];
    const checks   = Array.isArray(vr.project_checks) ? vr.project_checks : [];
    if (!projects.length) return '';
    const blocks = projects.map(proj => {
      const check = checks.find(ch => ch.title === proj.title);
      const verified = check ? check.title_verified : true;
      return `
        <div class="proj-card">
          <div class="proj-card-title">
            ${esc(proj.title||'')}
            <span class="${verified?'field-verified':'field-unverified'}" style="display:inline-flex;margin-left:.5rem;font-size:.78rem;">
              <i class="fa-solid fa-${verified?'circle-check':'triangle-exclamation'}" style="font-size:.75rem;"></i>
              ${verified ? 'Verified' : 'Unverified'}
            </span>
          </div>
          <p class="proj-card-desc">${esc(proj.description||'')}</p>
        </div>`;
    }).join('');
    return `
      <section>
        <div class="sec-title"><i class="fa-solid fa-diagram-project"></i> Projects</div>
        ${blocks}
      </section>`;
  }

  // ── 4h. Certifications
  function renderCertsSection(c, vr) {
    const certs  = Array.isArray(c.certifications) ? c.certifications : [];
    const checks = Array.isArray(vr.certification_checks) ? vr.certification_checks : [];
    if (!certs.length) return '';
    const blocks = certs.map(cert => {
      const check = checks.find(ch => ch.title === cert.title);
      const tv = check ? check.title_verified : true;
      const iv = check ? check.issuer_verified : true;
      return `
        <div class="cert-card">
          <div class="cert-card-title">${esc(cert.title||'')}</div>
          <div style="font-size:.82rem;color:var(--text-secondary);">Issuer: ${esc(cert.issuer||'—')}
            <span class="${iv?'field-verified':'field-unverified'}" style="display:inline-flex;margin-left:.4rem;font-size:.75rem;"><i class="fa-solid fa-${iv?'circle-check':'triangle-exclamation'}" style="font-size:.7rem;"></i> ${iv?'Verified':'Unverified'}</span>
          </div>
        </div>`;
    }).join('');
    return `
      <section>
        <div class="sec-title"><i class="fa-solid fa-certificate"></i> Certifications</div>
        ${blocks}
      </section>`;
  }

  // ── 4i. Original Resume
  function renderResumeSection(item) {
    const content = item.resume_content || '(No resume content stored)';
    return `
      <section>
        <div class="sec-title"><i class="fa-regular fa-file-lines"></i> Original Resume <span style="font-size:.75rem;color:var(--text-secondary);font-weight:400;margin-left:.5rem;"><i class="fa-solid fa-lock"></i> Read-only</span></div>
        <div class="resume-viewer"><pre>${esc(content)}</pre></div>
      </section>`;
  }

  // ── 4j. Validation accordion
  function renderValidationAccordion(vr) {
    function rows(checks, labelFn, verifiedFn) {
      return (checks||[]).map(ch => {
        const ok = verifiedFn(ch);
        return `<div class="val-row"><i class="fa-solid fa-${ok?'circle-check':'triangle-exclamation'} ${ok?'ok':'warn'}"></i> ${labelFn(ch)}</div>`;
      }).join('');
    }

    const fieldRows = rows(vr.field_checks,
      c => `${capitalize(c.field)} — ${c.value||''}`,
      c => c.status === 'verified');

    const skillRows = rows(vr.skill_checks,
      c => `${c.skill}`,
      c => c.status === 'verified');

    const empRows = (vr.employment_checks||[]).map(c => `
      <div class="val-row"><i class="fa-solid fa-${c.title_verified?'circle-check':'triangle-exclamation'} ${c.title_verified?'ok':'warn'}"></i> ${esc(c.title||'')} — Title</div>
      <div class="val-row"><i class="fa-solid fa-${c.company_verified?'circle-check':'triangle-exclamation'} ${c.company_verified?'ok':'warn'}"></i> ${esc(c.company||'')} — Company</div>
    `).join('');

    const eduRows = (vr.education_checks||[]).map(c => `
      <div class="val-row"><i class="fa-solid fa-${c.degree_verified?'circle-check':'triangle-exclamation'} ${c.degree_verified?'ok':'warn'}"></i> ${esc(c.degree||'')} — Degree</div>
      <div class="val-row"><i class="fa-solid fa-${c.institution_verified?'circle-check':'triangle-exclamation'} ${c.institution_verified?'ok':'warn'}"></i> ${esc(c.institution||'')} — Institution</div>
    `).join('');

    const projRows = rows(vr.project_checks,
      c => `${c.title} — Title`,
      c => c.title_verified);

    const certRows = (vr.certification_checks||[]).map(c => `
      <div class="val-row"><i class="fa-solid fa-${c.title_verified?'circle-check':'triangle-exclamation'} ${c.title_verified?'ok':'warn'}"></i> ${esc(c.title||'')} — Title</div>
      <div class="val-row"><i class="fa-solid fa-${c.issuer_verified?'circle-check':'triangle-exclamation'} ${c.issuer_verified?'ok':'warn'}"></i> ${esc(c.issuer||'')} — Issuer</div>
    `).join('');

    function group(title, html) {
      if (!html) return '';
      return `<div class="val-group"><div class="val-group-title">${title}</div>${html}</div>`;
    }

    const body =
      group('Contact & Location', fieldRows) +
      group('Skills', skillRows) +
      group('Employment', empRows) +
      group('Education', eduRows) +
      group('Projects', projRows) +
      group('Certifications', certRows);

    if (!body.trim()) return '';

    return `
      <section>
        <div class="sec-title"><i class="fa-solid fa-magnifying-glass-chart"></i> Validation Details</div>
        <button class="accordion-trigger">
          <span>Show / Hide Validation Checks</span>
          <i class="fa-solid fa-chevron-down acc-arrow" style="transition:transform .25s;"></i>
        </button>
        <div class="accordion-body">${body}</div>
      </section>`;
  }

  // ════════════════════════════════════════════════════════
  //  5. ACTIONS
  // ════════════════════════════════════════════════════════
  function collectEdits() {
    const edits = {};
    detailPanel.querySelectorAll('.edit-input').forEach(inp => {
      edits[inp.dataset.field] = inp.value.trim();
    });
    return edits;
  }

  function setButtons(disabled) {
    ['btnReject','btnSave','btnApprove'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = disabled;
    });
  }

  function doSave() {
    setButtons(true);
    showToast('Saving changes…', 'info');
    const changes = collectEdits();
    fetch(`/api/review-queue/${selected.id}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes, reviewed_by: 'recruiter' })
    })
    .then(r => r.json())
    .then(data => {
      setButtons(false);
      if (data.success) {
        // update local state
        selected.candidate_data = data.data.candidate_data;
        candData = safeJson(data.data.candidate_data);
        showToast('Changes saved successfully!', 'success');
      } else {
        showToast('Save failed: ' + (data.error||'Unknown error'), 'error');
      }
    })
    .catch(e => { setButtons(false); showToast('Network error: ' + e.message, 'error'); });
  }

  function doApprove() {
    setButtons(true);
    showToast('Approving…', 'info');
    const changes = collectEdits();
    fetch(`/api/review-queue/${selected.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes, reviewed_by: 'recruiter' })
    })
    .then(r => r.json())
    .then(data => {
      setButtons(false);
      if (data.success) {
        selected.status = 'corrected';
        const idx = allItems.findIndex(i => i.id === selected.id);
        if (idx !== -1) allItems[idx].status = 'corrected';
        renderSidebar(filteredItems());
        showToast('Candidate approved & saved!', 'success');
        // Refresh detail header status pill
        const pill = detailPanel.querySelector('.status-pill');
        if (pill) { pill.className = 'status-pill corrected'; pill.textContent = 'corrected'; }
      } else {
        showToast('Approve failed: ' + (data.error||'Unknown error'), 'error');
      }
    })
    .catch(e => { setButtons(false); showToast('Network error: ' + e.message, 'error'); });
  }

  function doReject() {
    if (!confirm(`Reject this candidate (${selected.candidate_name})?`)) return;
    setButtons(true);
    fetch(`/api/review-queue/${selected.id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewed_by: 'recruiter' })
    })
    .then(r => r.json())
    .then(data => {
      setButtons(false);
      if (data.success) {
        selected.status = 'rejected';
        const idx = allItems.findIndex(i => i.id === selected.id);
        if (idx !== -1) allItems[idx].status = 'rejected';
        renderSidebar(filteredItems());
        showToast('Candidate rejected.', 'error');
        const pill = detailPanel.querySelector('.status-pill');
        if (pill) { pill.className = 'status-pill rejected'; pill.textContent = 'rejected'; }
      } else {
        showToast('Reject failed: ' + (data.error||'Unknown error'), 'error');
      }
    })
    .catch(e => { setButtons(false); showToast('Network error: ' + e.message, 'error'); });
  }

  // ════════════════════════════════════════════════════════
  //  6. UTILS
  // ════════════════════════════════════════════════════════
  function safeJson(raw, fallback = {}) {
    if (!raw) return fallback;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  function esc(str) {
    return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function capitalize(str) {
    return String(str||'').replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  let toastTimer = null;
  function showToast(msg, type = 'info') {
    toastMsg.textContent = msg;
    toastEl.className = `rq-toast ${type}`;
    const icon = toastEl.querySelector('i');
    icon.className = type === 'success' ? 'fa-solid fa-circle-check'
                   : type === 'error'   ? 'fa-solid fa-circle-exclamation'
                   : 'fa-solid fa-circle-info';
    toastEl.style.display = 'flex';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 3500);
  }

});
