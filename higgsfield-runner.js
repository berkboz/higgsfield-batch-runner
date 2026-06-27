/* =============================================================================
 *  Higgsfield batch runner  —  paste into DevTools Console on higgsfield.ai/ai/video
 * =============================================================================
 *
 *  WHAT IT DOES  (one generation at a time, fully sequential)
 *    For each CSV row:
 *      1. Removes any start-frame image already attached to the form.
 *      2. Uploads the row's image straight into the form's start-frame file input
 *         (no picker popover) and waits for the upload to finish.
 *      3. Sets the prompt in the <textarea> (via the native setter so React's state
 *         actually updates — otherwise Generate submits an empty/stale prompt).
 *      4. Clicks Generate, waits for the job card to appear (queued),
 *         then polls its status until it flips to "completed"
 *         (queued → in_progress → completed) before starting the next row.
 *    Moderation now happens at generation time: if a job hits a terminal status
 *    (e.g. ip_detected, failed, nsfw), that row is SKIPPED and the batch continues —
 *    it never hangs or aborts. A summary of done/skipped rows is logged at the end.
 *
 *  BEFORE YOU RUN: select your Model (e.g. Enhanced Seedance) and toggle Enhance
 *    on/off to taste — the script does NOT change those; it uses whatever is selected.
 *
 *  HOW TO USE
 *    1) Paste this whole file into the Console (press Enter).
 *    2) Run:  await HF.run()
 *       A green button appears at the top of the page:
 *         • click it once  → pick your CSV  (image,prompt)
 *         • click it again → pick the IMAGE FOLDER (filenames match the CSV)
 *       Then the batch runs on its own.
 *    Other commands:
 *       await HF.discover()   // highlight the controls it will use
 *       await HF.test()       // dry run row 1 (sets prompt + image, NO Generate)
 *       HF.stop()             // stop after the current step
 *       await HF.run(5)       // resume starting at row 6 (0-indexed)
 *
 *  CSV format (header required):
 *    image,prompt
 *    001.png,"long, multi-line ""prompt"" text ..."
 *
 *  Verified live on higgsfield.ai/ai/video: direct start-frame upload, the React
 *  <textarea> prompt set (confirmed submitted, not empty), start-frame replace, and
 *  the queued→in_progress→completed status lifecycle (job id stays stable throughout).
 * ============================================================================= */

(() => {
  if (window.HF && window.HF.__alive) { console.warn('HF already loaded. Use HF.run() / HF.stop(). To reload: window.HF=null then re-paste.'); return; }

  // ---- tunables ---------------------------------------------------------------
  const CFG = {
    clearTimeoutMs:    10000,         // max time to remove existing start frame(s)
    uploadTimeoutMs:   60000,         // max wait for the uploaded start frame to attach to the form
    generateRetryMs:   15000,         // after clicking Generate, wait this long for a job to start; else re-click
    generateMaxClicks: 6,             // max Generate clicks before giving up on a row
    pollMs:            3000,          // how often to poll job status
    jobDoneTimeout:    20 * 60 * 1000,// max wait for a job to complete
    stuckMs:           90000,         // if an UNKNOWN (non-running) status persists this long, treat the job as failed
    betweenRowsMs:     2000,          // breather between rows
  };

  // Job statuses. "running" = keep waiting; "completed" = success; anything else
  // (e.g. ip_detected = IP/moderation flag, failed, nsfw, moderated, rejected,
  // canceled) is terminal → that row is skipped and the batch moves on.
  const RUNNING_STATUS = new Set(['queued','pending','starting','preparing','in_queue','in_progress','processing','generating','running','rendering','uploading']);
  const BAD_STATUS     = new Set(['ip_detected','failed','error','canceled','cancelled','nsfw','moderated','rejected','blocked','content_moderated','content_violation','timed_out']);

  // ---- tiny helpers -----------------------------------------------------------
  const sleep   = ms => new Promise(r => setTimeout(r, ms));
  const log     = (...a) => console.log('%c[HF]', 'color:#a3e635;font-weight:bold', ...a);
  const warn    = (...a) => console.warn('[HF]', ...a);
  const err     = (...a) => console.error('[HF]', ...a);
  const visible = el => el && el.offsetParent !== null && el.getClientRects().length > 0;
  const hasCls  = (el, s) => el && typeof el.className === 'string' && el.className.includes(s);

  // ---- element discovery (selectors verified against the live DOM) -------------
  const FORM   = () => document.querySelector('form.generate-form') || document;

  function findPromptEditor() {
    const form = FORM();
    // Current Higgsfield UI: the prompt input is a <textarea> inside the generate form.
    const ta = form && form.querySelectorAll
      ? [...form.querySelectorAll('textarea')].find(t => visible(t))
      : null;
    if (ta) return ta;
    // Legacy fallback: the old Lexical contenteditable editor. NOTE: read-only history
    // cards also use [data-lexical-editor]; only match contenteditable="true" AND inside the form.
    return [...document.querySelectorAll('[data-lexical-editor="true"]')]
      .find(el => el.getAttribute('contenteditable') === 'true' && visible(el)
                  && (!form.contains || form.contains(el))) || null;
  }
  function findGenerateButton() {
    return [...FORM().querySelectorAll('button')]
      .find(b => visible(b) && /generate/i.test(b.textContent || '')) || null;
  }
  // The small X badge on each attached thumbnail (class -top-2 -right-2).
  function removeButtons() {
    return [...FORM().querySelectorAll('button')]
      .filter(b => { const c = (b.className || '').toString(); return c.includes('-top-2') && c.includes('-right-2') && visible(b); });
  }

  async function discover() {
    const editor = findPromptEditor(), genBtn = findGenerateButton(), input = startFrameInput();
    log('discover():');
    console.log('  prompt input  :', editor ? editor.tagName : '❌ NOT FOUND');
    console.log('  generate btn  :', genBtn || '❌ NOT FOUND');
    console.log('  start-frame in:', input || '❌ NOT FOUND');
    console.log('  attached now  :', removeButtons().length, 'start frame(s)');
    if (editor) editor.style.outline = '2px solid #a3e635';
    if (genBtn) genBtn.style.outline = '2px solid #f59e0b';
    setTimeout(() => [editor, genBtn].forEach(e => e && (e.style.outline = '')), 3000);
    return { editor, genBtn, input };
  }

  // ---- prompt input ------------------------------------------------------------
  // Higgsfield's create-form prompt is a React-controlled <textarea> (older builds used a
  // Lexical contenteditable). For a <textarea> we MUST go through the native value setter and
  // fire a real 'input' event, otherwise React keeps its old/empty state and Generate submits
  // the wrong prompt — the cause of "it generated without my prompt".
  function setTextareaValue(ta, text) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(ta, text); else ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function reactValueOf(el) {
    const k = Object.keys(el).find(k => k.startsWith('__reactProps'));
    const v = k && el[k] && el[k].value;
    return typeof v === 'string' ? v : null;
  }
  async function setPrompt(text) {
    const editor = findPromptEditor();
    if (!editor) throw new Error('Prompt editor not found');
    const want = text.trim().length;
    const need = Math.min(want, Math.max(20, Math.floor(want * 0.6)));
    editor.focus();

    if (editor.tagName === 'TEXTAREA') {
      setTextareaValue(editor, text);
      // Confirm React actually took the value (not just the DOM), so Generate can't fire stale.
      let dl = Date.now() + 4000, rv = reactValueOf(editor);
      while ((rv === null ? (editor.value || '') : rv).trim().length < need && Date.now() < dl) {
        await sleep(120); rv = reactValueOf(editor);
      }
      const domLen = (editor.value || '').trim().length;
      const reactLen = rv === null ? domLen : rv.trim().length;
      const got = Math.min(domLen, reactLen);
      if (got < 5) throw new Error('Prompt did not stick (textarea) — selector changed');
      if (got < need) warn('prompt only partially set (' + got + '/' + want + ' chars)');
      log('prompt set (dom ' + domLen + ' / react ' + (rv === null ? 'n/a' : reactLen) + ' / want ' + want + ')');
      return;
    }

    // Legacy Lexical contenteditable path.
    document.execCommand('selectAll', false, null);
    let pasted = false;
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      pasted = true;
    } catch (e) { warn('paste path threw, will try insertText', e); }
    const curLen = () => (editor.textContent || '').trim().length;
    let dl = Date.now() + 4000;
    while (curLen() < need && Date.now() < dl) await sleep(150);
    if (curLen() < need) {                                  // paste didn't take — insertText fallback
      editor.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      pasted = false;
      dl = Date.now() + 3000;
      while (curLen() < need && Date.now() < dl) await sleep(150);
    }
    const got = curLen();
    if (got < 5) throw new Error('Prompt did not stick — editor selector changed');
    if (got < need) warn('prompt only partially set (' + got + '/' + want + ' chars)');
    log('prompt set (' + got + '/' + want + ' chars)' + (pasted ? '' : ' [insertText fallback]'));
  }

  // Remove every start frame already attached (so each row REPLACES, never stacks).
  async function clearExistingFrames() {
    const dl = Date.now() + CFG.clearTimeoutMs;
    let removed = 0;
    while (Date.now() < dl) {
      const rb = removeButtons();
      if (!rb.length) break;
      rb[0].click();
      removed++;
      await sleep(400);
    }
    if (removeButtons().length) warn('could not remove all existing frames');
    if (removed) log('cleared ' + removed + ' existing start frame(s)');
    return removed;
  }

  // ---- start-frame upload -----------------------------------------------------
  // Higgsfield's current UI attaches the start frame via a direct <input type=file> in the
  // form — the old assets-picker popover + per-card "Check eligibility" flow is GONE. The form
  // exposes up to two image inputs: the LEFT slot = start frame, the RIGHT slot = optional end
  // frame. We only ever set the start frame. Moderation now happens at GENERATION time (the job
  // lands on a terminal status like ip_detected), which clickGenerateAndWait already handles.
  function startFrameInput() {
    const inputs = [...FORM().querySelectorAll('input[type="file"]')]
      .filter(i => !i.hasAttribute('webkitdirectory') && /image/.test(i.accept || ''));
    if (!inputs.length) return null;
    return inputs.sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)[0]; // leftmost = start
  }
  // The attached start-frame thumbnail (alt="Uploaded image"), if any.
  function startFrameImg() {
    return [...FORM().querySelectorAll('img')].find(im => /uploaded image/i.test(im.alt || '')) || null;
  }

  // Upload one file as the start frame: clear old frame(s) → set the start-frame input's files
  // directly (no OS dialog, no user-activation block) → wait for the thumbnail to attach.
  async function uploadFrame(file) {
    await clearExistingFrames();
    let input = startFrameInput();
    if (!input) { await sleep(500); input = startFrameInput(); }
    if (!input) throw new Error('start-frame file input not found in form');

    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    log('uploading ' + file.name + ' …');

    // Wait for the upload to FULLY finish, not just for the local preview to show. While the
    // file is still uploading the thumbnail src is a local "blob:" URL; once Higgsfield has the
    // asset it becomes an https://images.higgs.ai/… URL. Clicking Generate before this point
    // silently no-ops, so we block until the src is committed.
    const dl = Date.now() + CFG.uploadTimeoutMs;
    while (Date.now() < dl) {
      if (state.stopped) throw new Error('stopped');
      const im = startFrameImg();
      const committed = im && /^https?:/.test(im.currentSrc || im.src || '');
      if (committed) { log('start frame ready: ' + file.name); return file.name; }
      await sleep(400);
    }
    throw new Error('start frame never finished uploading for ' + file.name);
  }

  // ---- job lifecycle ----------------------------------------------------------
  const withStatusEls = () => [...document.querySelectorAll('[data-asset-id][data-job-status]')];
  const cardById = id => document.querySelector(`[data-asset-id="${id}"][data-job-status]`);
  // The newest result card whose id wasn't present before we clicked Generate.
  // (History is newest-first, so this is robust even if the job id were ever swapped.)
  function firstNewCard(before) {
    for (const el of withStatusEls()) {
      if (!before.has(el.getAttribute('data-asset-id'))) return el;
    }
    return null;
  }

  async function clickGenerateAndWait() {
    const before = new Set(withStatusEls().map(el => el.getAttribute('data-asset-id')));

    // 1) Click Generate until a new job card appears (first status is usually "queued").
    let card = null;
    for (let attempt = 1; attempt <= CFG.generateMaxClicks && !card; attempt++) {
      const btn = findGenerateButton();
      if (!btn) throw new Error('Generate button not found');
      if (btn.disabled) warn('Generate looks disabled — clicking anyway');
      btn.click();
      log(`clicked Generate (attempt ${attempt}/${CFG.generateMaxClicks}); waiting up to ${CFG.generateRetryMs/1000}s for the job to start…`);
      const dl = Date.now() + CFG.generateRetryMs;
      while (Date.now() < dl) {
        if (state.stopped) throw new Error('stopped');
        card = firstNewCard(before);
        if (card) break;
        await sleep(1000);
      }
      if (!card) warn('no job appeared — clicking Generate again');
    }
    if (!card) { warn('Generate never produced a job (start frame may not be ready)'); return { ok: false, status: 'no-job' }; }
    const jobId = card.getAttribute('data-asset-id');
    const short = jobId.slice(0, 8) + '…';
    log('job started: ' + short + ' — polling status (queued → in_progress → completed)');

    // 2) Poll until completed (success) or a terminal status (skip the row).
    const doneDeadline = Date.now() + CFG.jobDoneTimeout;
    let last = null, unknownStatus = null, unknownSince = 0;
    while (Date.now() < doneDeadline) {
      if (state.stopped) throw new Error('stopped');
      const el = cardById(jobId) || firstNewCard(before);
      const status = el ? el.getAttribute('data-job-status') : '(card gone)';
      if (status !== last) { log('  status: ' + status); last = status; }

      if (status === 'completed') { log('✅ completed: ' + short); return { ok: true, jobId, status }; }
      if (BAD_STATUS.has(status)) { warn('✋ terminal status "' + status + '" for ' + short + ' — skipping this row'); return { ok: false, jobId, status }; }

      if (RUNNING_STATUS.has(status) || status === '(card gone)') {
        unknownStatus = null;                       // healthy progress; reset the unknown watchdog
      } else {
        // Unknown status we don't recognize — wait briefly; if it sticks, treat as terminal.
        if (status !== unknownStatus) { unknownStatus = status; unknownSince = Date.now(); }
        else if (Date.now() - unknownSince > CFG.stuckMs) {
          warn('✋ unknown status "' + status + '" stuck >' + (CFG.stuckMs/1000) + 's for ' + short + ' — skipping this row');
          return { ok: false, jobId, status };
        }
      }
      await sleep(CFG.pollMs);
    }
    warn('⏱️ job did not complete within timeout: ' + short + ' — skipping this row');
    return { ok: false, jobId, status: 'timeout' };
  }

  // ---- CSV parser (RFC-4180: quoted fields, commas, newlines, "" escapes) -----
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], n = text[i + 1];
      if (inQ) {
        if (c === '"' && n === '"') { field += '"'; i++; }
        else if (c === '"') inQ = false;
        else field += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\r') { /* skip */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    const header = rows.shift().map(h => h.trim().toLowerCase());
    return rows
      .filter(r => r.some(c => c.trim() !== ''))
      .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
  }

  // ---- state + file loading ---------------------------------------------------
  const state = { rows: [], images: new Map(), stopped: false, running: false };

  // File pickers must open from a REAL click (browsers block console-triggered pickers).
  // Mount a button: first click picks the CSV, second picks the image folder.
  function load() {
    return new Promise((resolve, reject) => {
      const existing = document.getElementById('hf-picker'); if (existing) existing.remove();
      const btn = document.createElement('button');
      btn.id = 'hf-picker';
      btn.textContent = '📁 HF — click to pick your CSV';
      Object.assign(btn.style, {
        position: 'fixed', zIndex: 2147483647, top: '14px', left: '50%',
        transform: 'translateX(-50%)', padding: '14px 24px', background: '#a3e635',
        color: '#111', border: 'none', borderRadius: '12px',
        font: '600 15px system-ui, sans-serif', cursor: 'pointer',
        boxShadow: '0 6px 24px rgba(0,0,0,.45)',
      });
      document.body.appendChild(btn);
      log('👉 green button at the TOP of the page — click to pick CSV, then click again to pick the IMAGE FOLDER.');

      let stage = 0;
      btn.onclick = () => {
        if (stage === 0) {
          const csv = document.createElement('input');
          csv.type = 'file'; csv.accept = '.csv,text/csv,text/plain';
          csv.onchange = async () => {
            const f = csv.files[0]; if (!f) return;
            try {
              state.rows = parseCSV(await f.text());
              log('loaded ' + state.rows.length + ' rows from ' + f.name);
              stage = 1;
              btn.textContent = '📂 now click to pick the IMAGE FOLDER';
            } catch (e) { btn.remove(); reject(e); }
          };
          csv.click();
        } else {
          const dir = document.createElement('input');
          dir.type = 'file'; dir.webkitdirectory = true; dir.multiple = true;
          dir.onchange = () => {
            state.images = new Map([...dir.files].map(x => [x.name, x]));
            log('loaded ' + state.images.size + ' images from folder');
            const missing = state.rows.filter(r => !state.images.has(r.image)).map(r => r.image);
            if (missing.length) warn('⚠️ ' + missing.length + ' row(s) have NO matching image:', missing);
            else log('✅ every row has a matching image');
            btn.remove();
            resolve(state.rows.length);
          };
          dir.click();
        }
      };
    });
  }

  // ---- dry test: row 1, no Generate -------------------------------------------
  async function test() {
    if (!state.rows.length) await load();
    const r = state.rows[0];
    log('TEST row 1 →', r.image);
    const img = state.images.get(r.image);
    if (!img) { warn('no image file for ' + r.image); return; }
    await uploadFrame(img);
    await setPrompt(r.prompt);
    log('TEST done — prompt + start frame set. Generate was NOT clicked.');
  }

  // ---- main loop --------------------------------------------------------------
  async function run(startIndex = 0) {
    if (state.running) { warn('already running'); return; }
    if (!state.rows.length) await load();
    state.stopped = false; state.running = true;
    const summary = { done: [], skipped: [] };
    let lastImage = null;   // reuse the attached frame across consecutive rows with the same image
    log('▶️ starting batch at row ' + (startIndex + 1) + ' of ' + state.rows.length);
    try {
      for (let i = startIndex; i < state.rows.length; i++) {
        if (state.stopped) { warn('stopped at row ' + (i + 1)); break; }
        const r = state.rows[i];
        log(`──── row ${i + 1}/${state.rows.length} — ${r.image} ────`);
        try {
          const img = state.images.get(r.image);
          if (!img) { warn('skipping — no image file for ' + r.image); summary.skipped.push(r.image + ' (no image)'); continue; }
          if (r.image === lastImage && (startFrameImg() || removeButtons().length > 0)) {
            log('reusing start frame already attached: ' + r.image);          // same image still on the form — nothing to do
          } else {
            await uploadFrame(img);                                           // new image (direct upload, instant)
            lastImage = r.image;
          }
          await setPrompt(r.prompt);
          const res = await clickGenerateAndWait();      // blocks until completed OR a terminal status
          if (res.ok) { log('✅ row ' + (i + 1) + ' done — ' + r.image); summary.done.push(r.image); }
          else { warn('⏭️ row ' + (i + 1) + ' skipped — ' + r.image + ' (' + res.status + ')'); summary.skipped.push(r.image + ' (' + res.status + ')'); }
        } catch (e) {
          if (String(e.message || e).includes('stopped')) { warn('stopped at row ' + (i + 1)); break; }
          err('row ' + (i + 1) + ' [' + r.image + '] error — skipping to next:', e.message || e);
          summary.skipped.push(r.image + ' (error)');
        }
        await sleep(CFG.betweenRowsMs);
      }
      log('🏁 batch finished — ' + summary.done.length + ' done, ' + summary.skipped.length + ' skipped');
      if (summary.skipped.length) warn('skipped rows:', summary.skipped);
    } finally {
      state.running = false;
    }
  }

  function stop() { state.stopped = true; warn('stop requested — will halt after the current step'); }

  window.HF = {
    __alive: true, CFG, discover, test, run, stop, load,
    _state: state,
    _findPromptEditor: findPromptEditor, _findGenerateButton: findGenerateButton,
    _startFrameInput: startFrameInput, _clearExistingFrames: clearExistingFrames,
    _uploadFrame: uploadFrame, _setPrompt: setPrompt,
  };
  log('loaded ✅  →  run  await HF.run()   (or HF.discover() / HF.test() first)');
})();
