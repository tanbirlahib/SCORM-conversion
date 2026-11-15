# SCORM Conversion Tool

> **Live website:** https://scorm-conversion-web.vercel.app/ (upload a file, download SCORM packages).
> Source in `web/` (front end + Vercel API), see [web/README.md](web/README.md).

Turn **HTML, video, audio or PDF** into LMS-ready **SCORM 2004 and SCORM 1.2** packages, built to the
SCORM Conversion Kit standard (docs 01 to 07): manifest at the zip root, one SCO per package,
launch file `res/index.html`, self-contained, completion + progress + resume tracked in both standards.

Pure Python 3 standard library. No `pip install`. Works on Windows, macOS and Linux.

## Quick start

```bash
python3 scorm_convert.py build lesson.html intro.mp4 policy.pdf --prefix "educateU Safety" --out dist
```

```bash
python3 scorm_convert.py validate dist/SCORM-1.2/educateU-Safety-Module-01-lesson-SCORM-1.2.zip
```

Output in `dist/`:

```
SCORM-2004/<Prefix>-Module-01-<slug>-SCORM-2004.zip   one per input (full 2004 schema set)
SCORM-1.2/<Prefix>-Module-01-<slug>-SCORM-1.2.zip     one per input (lightweight)
SCORM-Validation-Report.md                            Pre-Export Validation Report (kit doc 04)
<Prefix>-SCORM.zip + README.txt                       master bundle, delivery only
```

**Upload one inner module zip per LMS activity. Never upload the master zip.** Use the SCORM-1.2
folder if you are unsure what your LMS supports.

## What each input becomes

| Input | Learner page | Completion | Progress / resume |
|---|---|---|---|
| `.html` file | your page + wrapper injected first in `<head>` | your own `scormComplete()` call, otherwise on page load (warned) | your own `scormSave()` calls |
| folder of HTML | whole folder copied to `res/`, entry `index.html` (`--entry` to change) | same as above | same as above |
| video `.mp4 .webm .m4v .ogv .mov` | responsive player, optional captions | when `--video-threshold` (default 95%) has actually been played | furthest point watched; "Welcome back: Resume / Start over" |
| audio `.mp3 .m4a .aac .wav .ogg` | audio player | same as video | same as video |
| `.pdf` | inline viewer + "Open in new tab" | "Mark as complete" button (or `--pdf-complete open`) | opened / done flag |

Media files are stored inside the package (local, not CDN), so packages run offline and in any LMS iframe.

## Options

| Option | Meaning |
|---|---|
| `--versions both\|2004\|12` | which standards to build (default both) |
| `--prefix NAME` | course name used in file names and manifest identifiers |
| `--title "..."` | module title, once per input in order (default: HTML `<title>` or file name) |
| `--test-build` | Test Version: visible `TEST BUILD - timing disabled` banner, seeking never blocked |
| `--no-skip` | Final builds: learner cannot seek past the furthest point watched |
| `--video-threshold 0.95` | fraction of media that must be played to complete |
| `--captions file.vtt` | captions track for a video input |
| `--pdf-complete button\|open` | how a PDF module completes |
| `--html-complete auto\|load\|manual\|none` | `manual` adds a "Mark as complete" button |
| `--scored --mastery 80` | content reports a real score with `scormSetScore()`; adds 1.2 masteryscore |
| `--lang en-GB` | page language |
| `--no-master` | skip the master bundle |

Exit codes: `0` all packages pass (warnings allowed), `1` a package failed validation, `2` usage/input error.

## Wiring your own HTML (slides, quizzes)

The wrapper is injected as the first script in `<head>`, so these functions exist before your code runs:

```js
window.scormGetBookmark()                 // {cur,max,quiz} or null: call on boot to offer resume
window.scormSave(cur, max, quiz, total)    // call on every slide change
window.scormComplete()                     // call when the last slide is reached
window.scormFinishReturn()                 // optional Finish / Exit button
window.scormSaveState(obj, fraction)       // any small JSON state + progress 0..1
window.scormGetState()                     // that object back on the next session
window.scormSetScore(raw, min, max, passMark)  // scored content (build with --scored)
```

These match the kit's hook names (doc 05, B4), so content already wired for the kit works unchanged.

## Standards this tool follows (kit doc 04, section 6)

1. **Test vs Final behaviour.** `--test-build` produces a Test Version: a small fixed
   `TEST BUILD - timing disabled` notice, no seek blocking, completion tracking still on. Without it you
   get a Final build with no banner. For custom HTML the banner is added, but timers written inside your
   own code are not removed automatically (the tool warns).
2. **Timer handling.** The tool never invents durations or seat time. Media completion is based on what
   was actually played; any reading timer must come from your content with values you chose.
3. **SCORM 1.2 tracking.** `LMSInitialize`, `cmi.core.lesson_status` (incomplete, then completed; or
   passed/failed when scored), `cmi.core.lesson_location` + `cmi.suspend_data`, `cmi.core.score.raw/min/max`
   (progress as 0-100 because 1.2 has no progress_measure), `cmi.core.exit=suspend` mid-course,
   `LMSCommit` before `LMSFinish`.
4. **SCORM 2004 tracking.** `Initialize`, `cmi.completion_status` (+ `cmi.success_status` when scored),
   `cmi.location` + `cmi.suspend_data`, `cmi.progress_measure`, `cmi.score.raw/min/max/scaled`,
   `cmi.exit=suspend`, `Commit` before `Terminate`.
5. **Progress-tracking validation.** `tests/e2e_browser.js` plays media in Chromium against a mock LMS
   and checks `progress_measure` (2004) / `score.raw` (1.2).
6. **Completion-tracking validation.** The same test checks status is `incomplete` on launch and
   `completed` after the completion rule is met, for every input type, in both standards.
7. **Mobile responsiveness validation.** Pages use fluid `clamp()` sizing and breakpoints; the
   browser test checks for no horizontal overflow at 390px.
8. **Tablet responsiveness validation.** Not automated: check at ~768px before delivery (listed as
   NOT RUN in the generated report).
9. **Accessibility validation.** Built pages use `lang`, landmarks, labelled controls, a labelled
   progressbar, `aria-live` status text, keyboard-operable dialog, visible focus, SVG icons and reduced
   motion. A keyboard + screen-reader pass is still a manual step (NOT RUN in the report).
10. **Warning and reporting process.** Every build writes `SCORM-Validation-Report.md` (kit doc 04,
    section 5 format). Static checks are filled in from the validator; checks the tool cannot run are
    marked NOT RUN rather than claimed as passed. Every warning is listed. Always do one live LMS test upload.

## Validator

`python3 scorm_convert.py validate <zip|folder>` (or `python3 -m scormkit.validate`). Same checks as the
kit's `validate_scorm.py`, plus fixes found during the kit review (see `docs/KIT-REVIEW.md`):

- SCORM 2004 checks no longer pass on SCORM 1.2 calls (`Initialize(` used to match `LMSInitialize(`).
- Uses the manifest's **default** organization for the launch item.
- Fails zips with backslash paths (an LMS cannot find those files) or unsafe `..` paths.
- Catches `@import "https://..."`, unquoted `src=https://...`, `srcset`, `poster`.
- Flags manifest `<file>` entries that do not exist and leftover `{{ID}}` placeholders.
- Refuses manifests with a DOCTYPE/ENTITY (blocks XML entity attacks from untrusted zips).

## Not supported (yet)

- **Google Fonts / CDN assets** in HTML: the build is REJECTED by design (kit rule: self-contained).
  Embed the font as base64 `@font-face` first (the kit skill's `embed_google_fonts.py` does this).
- **PowerPoint**: export to HTML first, or follow kit doc 02 (PPT to SCORM).
- **Existing SCORM zips**: use `validate`; re-wrapping (kit doc 03) is not automated.
- PDF reading position cannot be tracked inside the browser's PDF viewer.

## Tests

```bash
python3 -m unittest discover -s tests
```

```bash
node tests/test_wrapper.js
```

```bash
node tests/e2e_browser.js
```

The end-to-end test needs `ffmpeg` and Node with Playwright + Chromium.

## Layout

```
scorm_convert.py          CLI (build / validate)
scormkit/builder.py       staging, manifests, zips, report, master bundle
scormkit/templates.py     player pages (video/audio/PDF) + manifest templates
scormkit/wrapper.js       dual SCORM 2004 / 1.2 runtime wrapper
scormkit/validate.py      package validator
scormkit/schema-2004/     standard ADL/IMS SCORM 2004 schema files (copied into 2004 packages)
docs/KIT-REVIEW.md        deep check of the SCORM Conversion Kit
tests/                    unit, wrapper and browser tests
```
