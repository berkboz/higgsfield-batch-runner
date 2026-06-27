# Higgsfield Batch Runner

A single‑file **browser‑console** automation for [higgsfield.ai/ai/video](https://higgsfield.ai/ai/video).
Paste it into DevTools, point it at a CSV of prompts and a folder of start‑frame images, and it
generates videos **one at a time** — uploading each image, running Higgsfield's eligibility check,
pasting the prompt, clicking **Generate**, and waiting for the job to finish before starting the next.

No extension, no API keys, no build step. It just drives the page you're already logged into.

> Use it on **your own** Higgsfield account and content, and within Higgsfield's Terms of Service.
> It automates clicks you could do by hand; it doesn't bypass anything.

---

## What it does

For every row in your CSV it:

1. **Removes** any start‑frame image already attached to the form (so each row *replaces*, never stacks).
2. **Uploads** the row's image via the "Upload media" picker (sets the hidden file input directly — no OS dialog).
3. Runs the **"Check eligibility"** content check and waits for it to pass (or skips the row if *Not eligible*).
4. **Selects** the uploaded image so it becomes the start frame.
5. **Pastes** the prompt into the editor (and waits until it's fully committed).
6. Clicks **Generate**, waits for the new job card to appear, then polls its status
   `queued → in_progress → completed` before moving on.

If a job hits a terminal status (`ip_detected`, `failed`, `nsfw`, `moderated`, …) the row is **skipped**
and the batch keeps going — it never hangs or aborts. A `done / skipped` summary is logged at the end.

**Repeated images are fast:** if several consecutive rows use the same image, it uploads + eligibility‑checks
it **once**, then re‑attaches the already‑uploaded asset from the grid (~0.5 s) for the repeats.

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
| `eligTimeoutMs` | `40000` | Max wait for the "Check eligibility" content check to resolve |
| `uploadTimeoutMs` | `60000` | Max wait for an uploaded file to appear in the picker grid |
| `selectDelayMs` | `6000` | Per‑attempt wait for the frame to attach after Select |
| `selectMaxClicks` | `15` | Max Select clicks before giving up on attaching a frame |
| `generateRetryMs` | `15000` | Wait for a job to start after clicking Generate, else re‑click |
| `pollMs` | `3000` | How often to poll job status |
| `jobDoneTimeout` | `1200000` | Max wait for a single job to complete (20 min) |
| `stuckMs` | `90000` | An unknown, non‑running status stuck this long is treated as failed |

---

## How it works (selectors)

It targets the live DOM of the Create Video page:

- Prompt editor: `[data-lexical-editor="true"][contenteditable="true"]`
- Generate button: a `<button>` in `form.generate-form` whose text matches `/generate/i`
- Upload dropzone: the `min-h-[120px]` area (or the `+` button once a frame is attached)
- Assets picker popover: `[data-assets-picker-popover="true"]`, with a hidden `input[type=file]`
- Upload cards: `button[aria-label^="Select <id>"]` + a `Check eligibility` button per card
- Result/job cards: `[data-asset-id][data-job-status]` (`queued → in_progress → completed`)

If Higgsfield changes its markup these selectors may need updating; `await HF.discover()` helps you see what's found.

---

## Troubleshooting

- **Every row skips as "no image"** → your CSV filenames don't match the folder filenames (extension mismatch). Fix the CSV.
- **The picker doesn't open / file dialog blocked** → make sure you ran `await HF.run()` (it mounts a real button you click); browsers block console‑triggered file pickers.
- **A row is skipped with `ip_detected` / `Not eligible`** → Higgsfield's moderation flagged that image/prompt. That's the platform's filter, not the script.
- **Wrong image gets attached** → make sure you're on the latest version; the grid loads asynchronously and the script now waits for it to settle before picking the freshly‑uploaded asset.

---

## Disclaimer

Unofficial, community tool. Not affiliated with Higgsfield. Selectors and behavior can break when the
site updates. Use responsibly on your own account.
