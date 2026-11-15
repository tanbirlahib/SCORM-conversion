# SCORM Converter website

Front end + back end that turns HTML, video, audio and PDF files into SCORM 2004 and SCORM 1.2
packages. Hosted on Vercel. **No npm dependencies.**

**Live:** https://scorm-conversion-web.vercel.app/ (health check: [`/api/health`](https://scorm-conversion-web.vercel.app/api/health))

## How it works

1. The learner-facing page (`public/`) asks for the file type and settings.
2. As soon as a file is added, conversion starts:
   - **Server path** (`api/convert.js`, a Vercel Function): used when the file and the result fit
     Vercel's 4.5 MB request/response limit (about 2 MB input when building both versions).
   - **Browser path**: larger files are converted in the browser with the same engine, so they never
     leave the user's computer. The panel says which path ran.
3. Each package is checked against the SCORM rules, then the user downloads each package or the bundle.

```
public/
  index.html, styles.css, app.js, favicon.svg   front end
  engine/                                       conversion engine, shared by browser and API
    build.js      convert(): stage content, write manifests, zip, validate, bundle
    templates.js  learner pages + imsmanifest.xml templates
    validate.js   package checks (port of ../scormkit/validate.py)
    zip.js        dependency-free zip writer/reader with zip-bomb limits
    limits.js     shared size limits
    assets.js     GENERATED from ../scormkit (wrapper, player CSS/JS, 2004 schema files)
api/convert.js    POST multipart -> bundle zip + X-Scorm-Result summary header
api/health.js     GET status
scripts/          dev server (mirrors Vercel) and asset generator
tests/            unit + API tests, Chromium end-to-end test
vercel.json       output dir, function limits, security headers (strict CSP)
```

## Run locally

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run test:e2e
```

`npm run dev` serves http://localhost:3000. The end-to-end test needs Playwright + Chromium and ffmpeg.
After changing `../scormkit/wrapper.js` or `../scormkit/templates.py`, run `npm run assets`
(a test fails if they drift).

## API

`POST /api/convert` with `multipart/form-data`:

| Field | Value |
|---|---|
| `kind` | `html`, `video`, `audio` or `pdf` |
| `file` | the file (`.html`/`.htm`/`.zip` site, `.mp4 .m4v .webm .ogv .mov`, `.mp3 .m4a .aac .wav .ogg .oga`, `.pdf`) |
| `captions` | optional `.vtt` for video |
| `options` | JSON: `courseName`, `title`, `versions` (`["2004","1.2"]`), `testBuild`, `threshold` (0-1), `noSkip`, `pdfComplete` (`button`/`open`), `htmlComplete` (`auto`/`load`/`manual`/`none`), `lang` |

Returns `200 application/zip` (the bundle) with an `X-Scorm-Result` header (base64 JSON summary), or
JSON `{ "error": "..." }` with 400/413/415/422/500. 413 and 500 include `"fallback": "browser"`.

## Deploy (Vercel)

Live at https://scorm-conversion-web.vercel.app/. Project root directory: `web`. No build command; output
directory `public` (set in `vercel.json`). Pushes to `main` redeploy when the Vercel project is linked to this repo.
