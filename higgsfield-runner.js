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
    promptMaxAttempts: 6,             // give up setting the prompt after this many tries (then skip the row)
    uploadTimeoutMs:   120000,        // max wait for an uploaded file to appear in the picker grid
    pickerOpenMs:      12000,         // max wait for the assets picker to open after clicking Upload media
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

  // ---- keep-alive (defeat background-tab timer throttling) --------------------
  // When the laptop goes idle / the tab loses focus, Chrome throttles setTimeout to ~once a
  // minute. That stretched our 400ms upload-polls to 60s and made every upload "time out" even
  // though the file uploaded fine (this is exactly what skipped rows 59→86 overnight). An
  // AudioContext producing (inaudible) output marks the tab "audible", which exempts it from
  // that throttling. Started from the green button's click so the autoplay policy lets it run.
  const keepAlive = { ctx: null, on: false };
  function startKeepAlive() {
    if (keepAlive.on) { if (keepAlive.ctx && keepAlive.ctx.state !== 'running') keepAlive.ctx.resume().catch(() => {}); return; }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { warn('no AudioContext — keep the tab foreground / run `caffeinate -dimsu`'); return; }
      const ctx = new Ctx();
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      gain.gain.value = 0.0001;                  // inaudible, but enough to flag the tab as audible
      osc.type = 'sine'; osc.frequency.value = 30;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      ctx.resume && ctx.resume().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); });
      keepAlive.ctx = ctx; keepAlive.on = true;
      log('🔊 keep-alive on — background-tab timer throttling disabled while the batch runs');
    } catch (e) { warn('keep-alive failed (keep the tab foreground / run `caffeinate -dimsu`):', e.message || e); }
  }
  function stopKeepAlive() { try { keepAlive.ctx && keepAlive.ctx.close(); } catch (_) {} keepAlive.ctx = null; keepAlive.on = false; }

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
  const normalizedPrompt = text => String(text || '').replace(/\s+/g, ' ').trim();
  // For EQUALITY we ignore all whitespace. Round-tripping through a Lexical editor drops or
  // alters spaces at paragraph boundaries (e.g. "claims.\nOpening" → "claims.Opening"), which
  // left the prompt 1–2 chars short of the target and made the strict === match loop forever.
  // The words themselves still differ when the wrong/stale prompt is present, so this is safe.
  const comparePrompt = text => String(text || '').replace(/\s+/g, '');
  function rawPrompt(editor = findPromptEditor()) {
    if (!editor) return '';
    return editor.tagName === 'TEXTAREA' ? (editor.value || '') : (editor.innerText || '');
  }
  function currentPrompt(editor = findPromptEditor()) {
    return normalizedPrompt(rawPrompt(editor));
  }
  function promptMatches(editor, text) {
    return comparePrompt(rawPrompt(editor)) === comparePrompt(text);
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

  // A canonical Lexical editor state: root → one paragraph per line (blank line = empty paragraph).
  function buildLexicalState(text) {
    const children = String(text).replace(/\r\n?/g, '\n').split('\n').map(line => ({
      type: 'paragraph', version: 1, direction: 'ltr', format: '', indent: 0, textFormat: 0,
      children: line ? [{ type: 'text', version: 1, text: line, format: 0, style: '', mode: 'normal', detail: 0 }] : [],
    }));
    return { root: { type: 'root', version: 1, direction: 'ltr', format: '', indent: 0, children } };
  }
  // Set the prompt through Lexical's OWN API (editor.setEditorState). This is the robust path:
  // it replaces the entire document — including any @mention decorator node left over from the
  // previous row — WITHOUT us mutating the DOM. Mutating via execCommand fights Lexical's
  // MutationObserver and throws "Lexical error #222" once a decorator is present, which then
  // permanently empties the editor (the all-night "expected 1110, got 0 chars" retry loop).
  // setEditorState also fires update listeners, so Higgsfield's React state syncs and Generate
  // submits the right prompt. Verified live, including the attach-element-then-replace case.
  function setLexicalValue(editorEl, text) {
    const editor = editorEl && editorEl.__lexicalEditor;
    if (!editor || typeof editor.setEditorState !== 'function' || typeof editor.parseEditorState !== 'function')
      return false;
    try {
      editor.setEditorState(editor.parseEditorState(JSON.stringify(buildLexicalState(text))));
      return true;
    } catch (_) { return false; }
  }
  async function replaceContentEditableValue(editor, text) {
    // ONLY Lexical's editor-state API. We deliberately do NOT fall back to execCommand: mutating
    // the DOM directly is exactly what threw "Lexical error #222" and permanently emptied the
    // editor (the all-night "0 chars" loop). setEditorState rebuilds the whole document from
    // scratch, so it works even if the editor is currently empty. If it fails, setPrompt retries
    // cleanly and — past the attempt cap — the row is skipped with the editor left intact.
    return setLexicalValue(findPromptEditor() || editor, text) && !!(await waitForPrompt(text, 4000));
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
      if (!promptMatches(editor, text) || (rv !== null && comparePrompt(rv) !== comparePrompt(text)))
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

  // Higgsfield can commit a prompt change a beat late or re-render the editor node mid-batch, so
  // we reacquire and retry a few times. But the retry is CAPPED (promptMaxAttempts): a permanent
  // failure must NOT loop forever — that's what burned a whole night ("0 chars" forever). On
  // exhaustion we throw, and the run loop skips the row and moves on.
  async function setPrompt(text) {
    let attempt = 0;
    while (!state.stopped && attempt < CFG.promptMaxAttempts) {
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
        warn('prompt mismatch — clearing and retrying (attempt ' + attempt + '/' + CFG.promptMaxAttempts + '): '
          + (e.message || e));
        await sleep(CFG.promptRetryMs);
      }
    }
    if (state.stopped) throw new Error('stopped');
    throw new Error('prompt did not stick after ' + CFG.promptMaxAttempts + ' attempts — skipping row');
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
    const dl = Date.now() + CFG.pickerOpenMs;
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

  // ---- @-mention Elements (e.g. @BALDY-App) ----------------------------------
  // A prompt may reference saved Elements with @Name tokens. For each one that exists in
  // "My Elements", we open the assets picker's Elements tab, select the matching card, and
  // click "Use" — which attaches the element to the prompt box (toast: "1 element added").
  // This is the menu flow the UI itself uses; pasting "@Name" as plain text does NOT attach it.
  const elementMentions = text =>
    [...new Set([...String(text || '').matchAll(/@([A-Za-z0-9._-]+)/g)].map(m => m[1]))];

  // Clickable element cards inside the open picker, e.g. label "@BALDY-AppProp".
  function elementCards() {
    const p = PICKER();
    if (!p) return [];
    return [...p.querySelectorAll('div[role="button"]')]
      .filter(el => visible(el) && /cursor-pointer/.test((el.className || '').toString())
                    && /^@[A-Za-z0-9._-]+/.test((el.textContent || '').trim()));
  }
  const elementNameOf = card => {
    // The name and the type ("Prop"/"Character") are separate <p> leaves; the card's
    // textContent concatenates them ("@BALDY-AppProp"), so read the leaf that is exactly "@name".
    const leaf = [...card.querySelectorAll('*')]
      .filter(e => e.children.length === 0)
      .map(e => (e.textContent || '').trim())
      .find(t => /^@[A-Za-z0-9._-]+$/.test(t));
    const m = (leaf || '').match(/^@([A-Za-z0-9._-]+)$/);
    return m ? m[1] : '';
  };

  // Open the picker on the Elements tab (the form's "Elements" button opens it there).
  async function openElementsPicker() {
    if (PICKER() && elementCards().length) return;
    if (!PICKER()) {
      const btn = [...FORM().querySelectorAll('button')]
        .find(b => visible(b) && /^elements$/i.test((b.textContent || '').replace(/\s+/g, ' ').trim()));
      if (!btn) throw new Error('Elements button not found');
      btn.click();
      await sleep(600);
    }
    // Make sure the Elements tab (not Uploads) is active inside the popover.
    const tab = PICKER() && [...PICKER().querySelectorAll('button')]
      .find(b => visible(b) && /^elements$/i.test((b.textContent || '').trim()));
    if (tab) { tab.click(); }
    const dl = Date.now() + 6000;
    while (Date.now() < dl) {
      if (state.stopped) throw new Error('stopped');
      if (elementCards().length) return;
      await sleep(200);
    }
    throw new Error('Elements picker did not open / no elements listed');
  }

  function findElementCard(name) {
    const want = name.toLowerCase();
    return elementCards().find(c => elementNameOf(c).toLowerCase() === want) || null;
  }

  // Attach one element by name. Returns true if attached, false if no such element exists
  // (so an @mention that isn't a saved element is just left as prompt text).
  async function attachElement(name) {
    await openElementsPicker();

    let card = findElementCard(name);
    if (!card) {                                   // try the picker's search box for big libraries
      const search = PICKER() && PICKER().querySelector('input[type="text"], input[placeholder]');
      if (search) {
        const proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
        const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value').set;
        if (setter) setter.call(search, name); else search.value = name;
        search.dispatchEvent(new Event('input', { bubbles: true }));
        const dl = Date.now() + 4000;
        while (!card && Date.now() < dl) { await sleep(250); card = findElementCard(name); }
      }
    }
    if (!card) { warn('element @' + name + ' not found in My Elements — leaving as text'); await closePicker(); return false; }

    card.click();                                  // select the card
    await sleep(500);
    const useBtn = [...PICKER().querySelectorAll('button')]
      .find(b => visible(b) && /^\+?\s*use$/i.test((b.textContent || '').replace(/\s+/g, ' ').trim()));
    if (!useBtn) { await closePicker(); throw new Error('Use button not found after selecting @' + name); }
    useBtn.click();
    await sleep(1200);
    await closePicker();
    log('attached element @' + name);
    return true;
  }

  // Attach every known element referenced in the prompt (skips unknown @mentions).
  async function attachPromptElements(text) {
    const names = elementMentions(text);
    const attached = [];
    for (const name of names) {
      if (state.stopped) throw new Error('stopped');
      if (await attachElement(name)) attached.push(name);
    }
    return attached;
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
  // runningOnly: only accept a card that is actually RUNNING. The history list is virtualized,
  // so clicking Generate can render a PREVIOUS, already-`completed` video into the DOM — its id
  // isn't in `before` (it was scrolled off-screen at snapshot time), so a plain "first new card"
  // wrongly latches onto it and reports the row done in 0 ms while the real job is still rendering.
  function firstNewCard(before, runningOnly) {
    for (const el of withStatusEls()) {
      if (before.has(el.getAttribute('data-asset-id'))) continue;
      if (runningOnly && !RUNNING_STATUS.has(el.getAttribute('data-job-status'))) continue;
      return el;
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
        card = firstNewCard(before, true);   // RUNNING-only: ignore old completed cards the
        if (card) break;                     // virtualized history may render in on this click
        await sleep(1000);
      }
      if (!card) warn('no running job appeared — clicking Generate again');
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
      // Track THIS job by id only. Don't fall back to "first new card" — that can re-latch onto
      // a different (stale) card. If it briefly unmounts, '(card gone)' is treated as still-running.
      const el = cardById(jobId);
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
        startKeepAlive();                 // first real click = the user gesture the audio keep-alive needs
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
    const got = await attachPromptElements(r.prompt);
    if (got.length) log('elements attached: ' + got.map(n => '@' + n).join(', '));
    log('TEST done — prompt + start frame' + (got.length ? ' + elements' : '') + ' set. Generate was NOT clicked.');
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
          const elKey = elementMentions(r.prompt).join(',');
          // Frame reuse is only safe when the row has no @elements. Attaching an element adds a
          // media thumbnail, and setPrompt (run every row) wipes the in-editor mention chip, so
          // element rows always rebuild (clear → upload → re-attach) to avoid stacking duplicates.
          if (!elKey && r.image === lastImage && (startFrameImg() || removeButtons().length > 0)) {
            log('reusing start frame already attached: ' + r.image);          // same image still on the form — nothing to do
          } else {
            await uploadFrame(img);                                           // clears all media + uploads the start frame
            lastImage = r.image;
          }
          await ensurePrompt(r.prompt);                   // make the prompt text correct BEFORE attaching elements
          if (elKey) {                                    // attach @elements (e.g. @BALDY-App) as the LAST prompt edit
            const got = await attachPromptElements(r.prompt);
            if (got.length) log('elements attached: ' + got.map(n => '@' + n).join(', '));
          }
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
    keepAwake: startKeepAlive, stopKeepAwake: stopKeepAlive,
    _state: state,
    _findPromptEditor: findPromptEditor, _findGenerateButton: findGenerateButton,
    _pickerFileInput: pickerFileInput, _openPicker: openPicker,
    _clearExistingFrames: clearExistingFrames,
    _uploadFrame: uploadFrame, _setPrompt: setPrompt,
    _attachElement: attachElement, _attachPromptElements: attachPromptElements,
    _elementMentions: elementMentions,
  };
  log('loaded ✅  →  run  await HF.run()   (or HF.discover() / HF.test() first)');
})();
