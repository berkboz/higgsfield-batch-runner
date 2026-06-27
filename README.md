# Higgsfield Batch Runner

A single‑file **browser‑console** automation for [higgsfield.ai/ai/video](https://higgsfield.ai/ai/video).
Paste it into DevTools, point it at a CSV of prompts and a folder of start‑frame images, and it
generates videos **one at a time** — uploading each image as the start frame, setting the prompt,
clicking **Generate**, and waiting for the job to finish before starting the next.

No extension, no API keys, no build step. It just drives the page you're already logged into.

> Use it on **your own** Higgsfield account and content, and within Higgsfield's Terms of Service.
> It automates clicks you could do by hand; it doesn't bypass anything.

---

## What it does

For every row in your CSV it:

1. **Removes** any start‑frame image already attached to the form (so each row *replaces*, never stacks).
2. **Opens** the **Upload media** assets picker, uploads the row's image through its hidden file input,
   waits for eligibility, and attaches it as the start frame.
3. **Replaces** the prompt through the active React `<textarea>` or Lexical editor state, so the previous
   row's text cannot be submitted again.
4. Clicks **Generate**, waits for the new job card to appear, then polls its status
   `queued → in_progress → completed` before moving on.

Moderation now happens at **generation** time: if a job hits a terminal status
(`ip_detected`, `failed`, `nsfw`, `moderated`, …) the row is **skipped** and the batch keeps going —
it never hangs or aborts. A `done / skipped` summary is logged at the end.

**Repeated images are fast:** if consecutive rows use the same image and it's still on the form,
the upload step is skipped entirely for the repeats.

> **Before you run:** pick your **Model** (e.g. *Enhanced Seedance*) and set the **Enhance** toggle the way
> you want. The script uses whatever is currently selected — it doesn't change the model or enhance setting.
> (With *Enhance* on, Higgsfield rewrites your prompt before generating.)

---

## Usage

1. Open **higgsfield.ai/ai/video**, make sure you're logged in and the model/duration/ratio you want is selected.
2. Open DevTools → **Console** (`Cmd/Ctrl + Option/Shift + J`).
3. Paste the entire contents of [`higgsfield-runner.js`](./higgsfield-runner.js) and press **Enter**.
   You should see `loaded ✅`.
4. Run:
   ```js
   await HF.run()
   ```
5. A **green button** appears at the top of the page:
   - **click once** → pick your **CSV**
   - **click again** → pick the **image folder**

   Then the batch runs on its own.

### Other commands

```js
await HF.discover()   // highlight the controls it will use (sanity check)
await HF.test()       // dry run: row 1 — sets the image + prompt, does NOT click Generate
HF.stop()             // stop after the current step
await HF.run(5)       // resume starting at row 6 (0-indexed)
```

> Tip: run `await HF.test()` first and confirm the small thumbnail on the form is really your row‑1 image.

---

## CSV format

A header row is **required**, with `image` and `prompt` columns:

```csv
image,prompt
001.png,"Animate the uploaded image ... no cuts, no text."
002.png,"Single continuous 9:16 vertical shot ... no subtitles."
```

- Standard CSV quoting: wrap multi‑line prompts in `"..."`, and escape a literal quote as `""`.
- See [`example.csv`](./example.csv).

## Image folder

- Pick the folder that contains your start frames.
- **Filenames in the `image` column must match the files exactly — including the extension.**
  `001.webp` in the CSV will *not* match `001.png` on disk. (This is the #1 cause of "it didn't read my files":
  every row silently skips as "no image".)

---

## Configuration

Tune the constants in the `CFG` block at the top of the script if needed:

| Key | Default | Meaning |
|---|---|---|
| `clearTimeoutMs` | `10000` | Max time to remove existing start frame(s) |
| `uploadTimeoutMs` | `60000` | Max wait for the uploaded start frame to finish uploading |
| `generateRetryMs` | `15000` | Wait for a job to start after clicking Generate, else re‑click |
| `generateMaxClicks` | `6` | Max Generate clicks before giving up on a row |
| `pollMs` | `3000` | How often to poll job status |
| `jobDoneTimeout` | `1200000` | Max wait for a single job to complete (20 min) |
| `stuckMs` | `90000` | An unknown, non‑running status stuck this long is treated as failed |

---

## How it works (selectors)

It targets the live DOM of the Create Video page:

- Prompt input: the visible `<textarea>` inside `form.generate-form`
- Generate button: a `<button>` in `form.generate-form` whose text matches `/generate/i`
- Start‑frame input: the **left‑most** `input[type=file][accept*=image]` in the form (the right one is the optional *end frame*)
- Attached frame: an `<img alt="Uploaded image">`; the upload is "done" once its `src` becomes an `https://images.higgs.ai/…` URL (not a local `blob:` preview)
- Remove (X) badge: a `<button>` with the `-top-2 -right-2` classes
- Result/job cards: `[data-asset-id][data-job-status]` (`queued → in_progress → completed`)

If Higgsfield changes its markup these selectors may need updating; `await HF.discover()` helps you see what's found.

### Why a textarea?

Higgsfield's prompt box is a **React‑controlled `<textarea>`**. Assigning `.value` (or pasting) updates the DOM
but **not** React's internal state, so clicking Generate would submit an empty/old prompt. The script writes through
the native `HTMLTextAreaElement.prototype.value` setter and dispatches a real `input` event, then verifies React's
`__reactProps.value` actually picked up the text before clicking Generate. (Older builds used a Lexical
`contenteditable`; the script still falls back to that if no textarea is present.)

---

## Troubleshooting

- **Every row skips as "no image"** → your CSV filenames don't match the folder filenames (extension mismatch). Fix the CSV.
- **It generated without my prompt / an empty‑looking video** → you were on an old version that targeted the Lexical editor; Higgsfield's prompt box is now a `<textarea>`. Update to the latest `higgsfield-runner.js`.
- **Generate seems to do nothing on the first try** → the start frame hadn't finished uploading yet. The script waits for the upload to commit (img `src` → `images.higgs.ai`) before clicking, and re‑clicks Generate if no job appears.
- **A row is skipped with `ip_detected`** → Higgsfield's moderation flagged that image/prompt at generation time. That's the platform's filter, not the script.
- **Wrong model / prompt got rewritten** → the script doesn't touch the **Model** selector or the **Enhance** toggle. Set those manually before running.

---

## Disclaimer

Unofficial, community tool. Not affiliated with Higgsfield. Selectors and behavior can break when the
site updates. Use responsibly on your own account.
