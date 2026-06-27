/* =============================================================================
 *  Higgsfield batch runner  —  paste into DevTools Console on higgsfield.ai/ai/video
 * =============================================================================
 *
 *  WHAT IT DOES  (one generation at a time, fully sequential)
 *    For each CSV row:
 *      1. Replaces and verifies the prompt; mismatches are cleared and retried.
 *      2. Removes any start-frame image already attached to the form.
 *      3. Opens "Upload media", uploads the row's image through the assets picker,
 *         waits for eligibility, and attaches it as the start frame.
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
 *  Verified live on higgsfield.ai/ai/video: picker-based start-frame upload, the
 *  React/Lexical prompt replacement, start-frame replace, and the
 *  queued→in_progress→completed status lifecycle.
 * ============================================================================= */

(() => {
  if (window.HF && window.HF.__alive) { console.warn('HF already loaded. Use HF.run() / HF.stop(). To reload: window.HF=null then re-paste.'); return; }

  // ---- tunables ---------------------------------------------------------------
  const CFG = {
    clearTimeoutMs:    10000,         // max time to remove existing start frame(s)
    promptRetryMs:     1500,          // pause before clearing/re-pasting a mismatched prompt
    uploadTimeoutMs:   60000,         // max wait for an uploaded file to appear in the picker grid
    eligTimeoutMs:     40000,         // max wait for the picker eligibility check
    selectDelayMs:     6000,          // wait per attempt for the selected frame to attach
    selectMaxClicks:   15,            // max Select retries
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
  const PICKER = () => document.querySelector('[data-assets-picker-popover="true"]');

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
  // Empty-state "Upload media" dropzone.
  function findDropZone() {
    return [...FORM().querySelectorAll('div')]
      .find(d => hasCls(d, 'min-h-[120px]') && visible(d) && /upload media/i.test(d.textContent || '')) || null;
  }
  // The thumbnail grid and its "+" button, present when a frame is already attached.
  function mediaGrid() {
    return [...FORM().querySelectorAll('div')]
      .find(d => hasCls(d, 'grid-cols-[repeat(3,48px)]')) || null;
  }
  function plusAddButton() {
    const g = mediaGrid();
    return g && [...g.querySelectorAll('button')]
      .find(b => hasCls(b, 'size-[48px]') && hasCls(b, 'bg-surface-secondary')) || null;
  }
  // The small X badge on each attached thumbnail (class -top-2 -right-2).
  function removeButtons() {
    return [...FORM().querySelectorAll('button')]
      .filter(b => { const c = (b.className || '').toString(); return c.includes('-top-2') && c.includes('-right-2') && visible(b); });
  }

  async function discover() {
    const editor = findPromptEditor(), genBtn = findGenerateButton(), zone = findDropZone();
    log('discover():');
    console.log('  prompt input  :', editor ? editor.tagName : '❌ NOT FOUND');
    console.log('  generate btn  :', genBtn || '❌ NOT FOUND');
    console.log('  upload trigger:', zone || plusAddButton() || '❌ NOT FOUND');
    console.log('  attached now  :', removeButtons().length, 'start frame(s)');
    if (editor) editor.style.outline = '2px solid #a3e635';
    if (genBtn) genBtn.style.outline = '2px solid #f59e0b';
    if (zone) zone.style.outline = '2px solid #38bdf8';
    setTimeout(() => [editor, genBtn, zone].forEach(e => e && (e.style.outline = '')), 3000);
    return { editor, genBtn, zone };
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
  // Lexical renders newlines as separate paragraphs; innerText may add extra line breaks.
  // Whitespace-normalized equality still catches stale/appended text without false failures.
  const normalizedPrompt = text => String(text || '').replace(/\s+/g, ' ').trim();
  function currentPrompt(editor = findPromptEditor()) {
    if (!editor) return '';
    return normalizedPrompt(editor.tagName === 'TEXTAREA' ? editor.value : editor.innerText);
  }
  function promptMatches(editor, text) {
    return currentPrompt(editor) === normalizedPrompt(text);
  }

  async function waitForPrompt(text, ms) {
    const dl = Date.now() + ms;
    while (Date.now() < dl) {
      const live = findPromptEditor();
      if (live && promptMatches(live, text)) return live;
      await sleep(100);
    }
    return null;
  }

  // Select the editor's whole contents, then yield a tick. CRITICAL: Lexical doesn't read
  // the DOM selection directly — it syncs its internal selection from a 'selectionchange'
  // event that fires on a LATER microtask. Issuing execCommand synchronously after addRange
  // hits Lexical with a stale/empty selection, so the edit is a silent no-op (this was the
  // cause of the "expected/got mismatch" retry loop: the old prompt was never removed).
  async function selectAllIn(editor) {
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    await sleep(40);   // let Lexical ingest the selection before we mutate
  }
  async function clearContentEditableValue(editor) {
    for (let attempt = 0; attempt < 3; attempt++) {
      // Generate can re-render and replace the entire editor node. Never keep operating
      // on a detached reference from the previous row.
      editor = findPromptEditor() || editor;
      await selectAllIn(editor);
      document.execCommand('delete', false, null);
      const clearedLiveEditor = await waitForPrompt('', 1200);
      if (clearedLiveEditor) return clearedLiveEditor;
    }
    return null;
  }
  async function replaceContentEditableValue(editor, text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (let attempt = 0; attempt < 3; attempt++) {
      editor = findPromptEditor() || editor;
      // Select existing content first so the first insertText REPLACES it (no separate
      // delete needed). execCommand fires real beforeinput events that Lexical honors,
      // and per-line inserts avoid Lexical mangling one big multiline transaction.
      await selectAllIn(editor);
      try {
        for (let i = 0; i < lines.length; i++) {
          if (i) document.execCommand('insertParagraph', false, null);
          if (lines[i]) document.execCommand('insertText', false, lines[i]);
        }
      } catch (_) {}
      if (await waitForPrompt(text, 5000)) return true;

      // Fallback: clear, then a beforeinput carrying a DataTransfer. Lexical's paste path
      // reads event.dataTransfer directly — unlike a synthetic ClipboardEvent, whose
      // clipboardData is null in Chrome, so the old paste delivered nothing.
      editor = await clearContentEditableValue(findPromptEditor() || editor);
      if (editor) {
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          editor.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'insertFromPaste', dataTransfer: dt, bubbles: true, cancelable: true,
          }));
        } catch (_) {}
        if (await waitForPrompt(text, 5000)) return true;
      }
    }
    return false;
  }
  async function setPromptAttempt(text) {
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
      if (!promptMatches(editor, text) || (rv !== null && normalizedPrompt(rv) !== normalizedPrompt(text)))
        throw new Error('Prompt replace failed (textarea)');
      log('prompt set (dom ' + domLen + ' / react ' + (rv === null ? 'n/a' : reactLen) + ' / want ' + want + ')');
      return;
    }

    // Lexical/contenteditable path.
    if (!await replaceContentEditableValue(editor, text)) {
      throw new Error('Prompt replace failed (Lexical/contenteditable; expected '
        + normalizedPrompt(text).length + ', got ' + currentPrompt().length + ' normalized chars)');
    }
    log('prompt replaced (' + want + '/' + want + ' chars)');
  }

  // Higgsfield can commit a Lexical paste several seconds late or replace the editor
  // node during a generation. Never abort/skip a row for that transient mismatch:
  // reacquire, clear and paste again until the active editor is exactly correct.
  async function setPrompt(text) {
    let attempt = 0;
    while (!state.stopped) {
      attempt++;
      const live = findPromptEditor();
      if (live && promptMatches(live, text)) {
        log('prompt verified' + (attempt > 1 ? ' after ' + attempt + ' attempts' : ' (already correct)'));
        return;
      }
      try {
        await setPromptAttempt(text);
        return;
      } catch (e) {
        warn('prompt mismatch — clearing and retrying (attempt ' + attempt + '): '
          + (e.message || e));
        await sleep(CFG.promptRetryMs);
      }
    }
    throw new Error('stopped');
  }

  async function ensurePrompt(text) {
    const editor = findPromptEditor();
    if (editor && promptMatches(editor, text)) return;
    warn('prompt changed before Generate — repairing it now');
    await setPrompt(text);
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

  // ---- assets-picker start-frame upload --------------------------------------
  // The form's "Upload media" card is only a trigger. Its hidden file input is mounted
  // after the assets picker opens, so the picker must be opened before setting files.
  function frameThumbs() {
    return [...FORM().querySelectorAll('img')]
      .filter(im => /uploaded image/i.test(im.alt || '')
        || /images\.higgs\.ai|cloudfront|cdn\.higgsfield/.test(im.currentSrc || im.src || ''));
  }
  function startFrameImg() { return frameThumbs()[0] || null; }
  function frameHasAsset(assetId) {
    return frameThumbs().some(im => {
      const src = im.currentSrc || im.src || '';
      try { return decodeURIComponent(src).includes(assetId); }
      catch (_) { return src.includes(assetId); }
    });
  }
  async function waitForFrameAsset(assetId, ms) {
    const dl = Date.now() + ms;
    while (Date.now() < dl) {
      if (state.stopped) throw new Error('stopped');
      if (frameHasAsset(assetId)) return true;
      await sleep(400);
    }
    return false;
  }

  function pickerFileInput() {
    const p = PICKER();
    return p && [...p.querySelectorAll('input[type="file"]')]
      .find(i => !i.hasAttribute('webkitdirectory') && /image/.test(i.accept || '')) || null;
  }
  function pickerSelectButtons() {
    const p = PICKER();
    return p ? [...p.querySelectorAll('button[aria-label^="Select "]')] : [];
  }
  const selId = b => (b.getAttribute('aria-label') || '').slice(7);

  async function openPicker() {
    if (pickerFileInput()) return;
    const trigger = findDropZone() || plusAddButton();
    if (!trigger) throw new Error('Upload trigger not found (no dropzone or + button)');
    trigger.click();
    const dl = Date.now() + 6000;
    while (Date.now() < dl) {
      if (state.stopped) throw new Error('stopped');
      if (pickerFileInput()) return;
      await sleep(150);
    }
    throw new Error('assets picker did not open after clicking Upload media');
  }
  async function closePicker() {
    const c = PICKER() && PICKER().querySelector('button[aria-label="Close assets picker"]');
    if (c) { c.click(); await sleep(300); }
  }

  async function selectEligibleAsset(fid) {
    const cardOf = () => {
      const b = pickerSelectButtons().find(x => selId(x) === fid);
      return b ? (b.closest('[data-assets-picker-media-card="true"]') || b.parentElement) : null;
    };
    const cardText = () => cardOf() ? (cardOf().textContent || '') : '';

    await sleep(400);
    let eligible = false;
    const eDeadline = Date.now() + CFG.eligTimeoutMs;
    while (Date.now() < eDeadline) {
      if (state.stopped) throw new Error('stopped');
      const txt = cardText();
      if (/not eligible/i.test(txt)) throw new Error('image NOT eligible (moderation)');
      if (/checking/i.test(txt)) { await sleep(800); continue; }
      const card = cardOf();
      const check = card && [...card.querySelectorAll('button')]
        .find(b => /check eligibility/i.test(b.textContent || ''));
      if (check) { check.click(); await sleep(800); continue; }
      eligible = true;
      break;
    }
    if (!eligible) throw new Error('eligibility check timed out');

    let applied = false;
    for (let attempt = 1; attempt <= CFG.selectMaxClicks && !applied; attempt++) {
      if (state.stopped) throw new Error('stopped');
      const btn = pickerSelectButtons().find(b => selId(b) === fid);
      if (btn) btn.click();
      else if (!PICKER()) break;
      applied = await waitForFrameAsset(fid, CFG.selectDelayMs);
      if (!applied && PICKER()) warn('frame not attached yet — retrying Select (' + attempt + ')');
    }
    await closePicker();
    if (!applied) throw new Error('selected asset ' + fid + ' never attached to the form');
  }

  async function uploadFrame(file) {
    await clearExistingFrames();
    await openPicker();

    // The picker lazy-loads old cards. Wait until both its count and newest/top id are
    // stable before uploading; otherwise a late old card can look like our new upload.
    let prevSignature = '', stable = 0;
    const gridDL = Date.now() + 12000;
    while (Date.now() < gridDL) {
      const buttons = pickerSelectButtons();
      const signature = buttons.length + ':' + (buttons[0] ? selId(buttons[0]) : '');
      if (buttons.length > 0 && signature === prevSignature) {
        if (++stable >= 8) break;
      } else {
        stable = 0;
        prevSignature = signature;
      }
      await sleep(250);
    }
    const beforeTop = pickerSelectButtons()[0];
    const beforeTopId = beforeTop ? selId(beforeTop) : null;
    // The picker can re-render while its grid loads, so reacquire the live input afterwards.
    let input = pickerFileInput();
    const inputDL = Date.now() + 4000;
    while (!input && Date.now() < inputDL) {
      await sleep(150);
      input = pickerFileInput();
    }
    if (!input) throw new Error('hidden file input not found in assets picker');

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    log('uploading ' + file.name + ' …');

    // Uploads are prepended as the newest/top card. Only accept a changed top id whose
    // own image URL contains that id. Never infer freshness from any other newly rendered
    // card: the virtualized grid continuously adds old assets while it loads.
    let fresh = null, candidateId = null, candidateStable = 0;
    const upDeadline = Date.now() + CFG.uploadTimeoutMs;
    while (Date.now() < upDeadline) {
      if (state.stopped) throw new Error('stopped');
      if (!PICKER()) break;
      const top = pickerSelectButtons()[0];
      const id = top ? selId(top) : null;
      const card = top && (top.closest('[data-assets-picker-media-card="true"]') || top.parentElement);
      const img = card && card.querySelector('img');
      const src = img && (img.currentSrc || img.src || '');
      const ready = id && id !== beforeTopId && src.includes(id)
        && !/uploading/i.test(PICKER().textContent || '');
      if (ready) {
        if (id === candidateId) candidateStable++;
        else { candidateId = id; candidateStable = 1; }
        if (candidateStable >= 3) { fresh = top; break; }
      } else {
        candidateId = null;
        candidateStable = 0;
      }
      await sleep(500);
    }

    let fid = null;
    if (PICKER()) {
      if (!fresh) throw new Error('upload ' + file.name + ' never appeared in the picker (timeout)');
      fid = selId(fresh);
      log('upload appeared (' + fid.slice(0, 8) + '…) — checking eligibility');
      await selectEligibleAsset(fid);
    }

    if (fid && !frameHasAsset(fid) && !(await waitForFrameAsset(fid, 8000)))
      throw new Error('wrong or missing start frame for ' + file.name + ' (expected asset ' + fid + ')');
    log('start frame ready: ' + file.name);
    return fid || file.name;
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
    await setPrompt(r.prompt);
    await uploadFrame(img);
    await ensurePrompt(r.prompt);
    log('TEST done — prompt + start frame set. Generate was NOT clicked.');
  }

  // ---- main loop --------------------------------------------------------------
  async function run(startIndex = 0) {
    if (state.running) { warn('already running'); return; }
    if (!state.rows.length) await load();
    state.stopped = false; state.running = true;
    const summary = { done: [], skipped: [], haltReason: null };
    let lastImage = null;   // reuse the attached frame across consecutive rows with the same image
    log('▶️ starting batch at row ' + (startIndex + 1) + ' of ' + state.rows.length);
    try {
      for (let i = startIndex; i < state.rows.length; i++) {
        if (state.stopped) {
          summary.haltReason = summary.haltReason || 'stop requested';
          warn('stopped at row ' + (i + 1));
          break;
        }
        const r = state.rows[i];
        log(`──── row ${i + 1}/${state.rows.length} — ${r.image} ────`);
        try {
          const img = state.images.get(r.image);
          if (!img) { warn('skipping — no image file for ' + r.image); summary.skipped.push(r.image + ' (no image)'); continue; }
          // Fail before touching the image if Higgsfield changes its prompt editor.
          try {
            await setPrompt(r.prompt);
          } catch (promptError) {
            throw new Error('Prompt setup failed — ' + (promptError.message || promptError));
          }
          if (r.image === lastImage && (startFrameImg() || removeButtons().length > 0)) {
            log('reusing start frame already attached: ' + r.image);          // same image still on the form — nothing to do
          } else {
            await uploadFrame(img);                                           // new image via assets picker
            lastImage = r.image;
          }
          await ensurePrompt(r.prompt);                   // repair if picker disturbed it
          const res = await clickGenerateAndWait();      // blocks until completed OR a terminal status
          if (res.ok) { log('✅ row ' + (i + 1) + ' done — ' + r.image); summary.done.push(r.image); }
          else { warn('⏭️ row ' + (i + 1) + ' skipped — ' + r.image + ' (' + res.status + ')'); summary.skipped.push(r.image + ' (' + res.status + ')'); }
        } catch (e) {
          if (String(e.message || e).includes('stopped')) {
            summary.haltReason = 'stop requested';
            warn('stopped at row ' + (i + 1));
            break;
          }
          err('row ' + (i + 1) + ' [' + r.image + '] error — skipping to next:', e.message || e);
          summary.skipped.push(r.image + ' (error)');
        }
        await sleep(CFG.betweenRowsMs);
      }
      if (summary.haltReason)
        err('🛑 batch halted — ' + summary.done.length + ' done, ' + summary.skipped.length
          + ' skipped — ' + summary.haltReason);
      else
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
    _pickerFileInput: pickerFileInput, _openPicker: openPicker,
    _clearExistingFrames: clearExistingFrames,
    _uploadFrame: uploadFrame, _setPrompt: setPrompt,
  };
  log('loaded ✅  →  run  await HF.run()   (or HF.discover() / HF.test() first)');
})();
