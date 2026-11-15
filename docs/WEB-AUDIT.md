# Code audit: website, API and engine

Scope: `web/` (front end, API, shared engine) and how it reuses `scormkit/`.

## Fixed during the audit

| Area | Issue | Fix |
|---|---|---|
| Limits | Vercel caps request **and** response at 4.5 MB; the bundle holds the input once per version, so a 4 MB input would fail on the response. | `limits.js` estimates the bundle size; the server only takes inputs that fit, the browser converts the rest. Tested both paths. |
| Security | Untrusted zips (HTML sites) could be zip bombs or contain `..` paths. | `readZip` caps entry count and expanded size (12 MB on server), rejects encrypted entries and unsafe paths; tests cover both. |
| Security | User-supplied titles end up in HTML pages and XML manifests. | Escaped in both; test injects `<img onerror>` and checks it is inert. |
| Security | `innerHTML` used for result cards. | Replaced with a `<template>` clone and `textContent`. |
| Security | No browser hardening headers. | Strict CSP (`self` only, no inline script/style), HSTS, nosniff, COOP, Permissions-Policy, frame-ancestors none. E2E test confirms zero CSP errors. |
| Validation | Manifests with DOCTYPE/ENTITY (XXE / entity expansion). | Rejected in both the JS and Python validators. |
| Correctness | Options from the client are untrusted. | `normalizeOptions` whitelists every field (versions, threshold range, lang pattern, enums). |
| UX | Mobile: version control wrapped, dropdown text clipped, low-contrast hint on the dark panel. | Fixed; checked in screenshots at 390 px. |
| Drift | JS engine and Python tool could diverge. | Wrapper, player CSS/JS and schema files are generated from `scormkit/`; a test fails if they drift, and JS-built packages are validated by the Python validator in tests. |

## Verified

- 19 unit/API tests (`npm test`), 22 Chromium end-to-end checks on desktop and mobile
  (`npm run test:e2e`): server path, browser path, wrong-type error and recovery, downloads validated
  by the Python validator, remembered settings, no horizontal scroll, no console/CSP errors.
- Python tool: 15 unit tests, 8 wrapper tests, 24 browser checks (repo root).

## Known gaps (not fixed)

- **No rate limiting** on `/api/convert`. Add a Vercel Firewall rate-limit rule before heavy public use.
- The manifest checks in `validate.js` use targeted patterns, not a full XML parser (no npm packages
  could be installed here). Fine for packages this tool builds; a third-party manifest with unusual
  formatting could be misread.
- Manifest/page templates exist in both Python and JS; the shared parts are generated, the f-string
  shells are maintained in two places.
- No live LMS test: checks confirm package structure and runtime calls, not a specific LMS's behaviour.
- Tablet width (768 px) and screen-reader passes were not automated.
