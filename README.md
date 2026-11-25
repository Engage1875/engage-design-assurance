# ENGAGE: Design Assurance

ENGAGE is a single-page browser tool for design assurance: interface registers,
stage programme, the Project brief, statutory approvals, comments resolution and
PDF request packs. It runs entirely in the browser and keeps project data in the
browser's storage and in saved project files.

## Layout

| Path | What it is |
|---|---|
| `src/Engage.html` | The main app (HTML, CSS and JavaScript in one file) |
| `src/ProjectBrief.html` | The Project brief app, shown inside the main app |
| `data/register.json` | The interface component register (47 components, 3,074 interfaces) |
| `data/statutory.json` | The statutory approvals register (233 approvals) |
| `VERSION` | Version label and build date (the app's single version constant) |
| `tools/build.py` | Joins the above into one file, `dist/Engage.html` |
| `tools/dev_server.js` | Runs the whole site locally, sign-in included |
| `tests/` | Browser tests of the app and of sign-in |
| `api/` | Sign-in service (emailed one-time codes, approved users, administrators) |
| `web/` | Sign-in page, admin page and Azure Static Web App settings |
| `docs/SETUP_GUIDE.md` | Plain-English guide to running, deploying and administering ENGAGE |

## Build

```
python3 tools/build.py
```

Open `dist/Engage.html` in a browser. Never edit `dist/` by hand; edit `src/` or
`data/` and rebuild.

## Test

```
npm ci && npx playwright install chromium
npm test                      # app tests
cd api && npm ci && npm test  # sign-in service tests
```

## Deploy

See [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md). In short: Azure Static Web Apps (Free) hosts
the sign-in page and the sign-in service; the app is served only after sign-in; a push to
`main` tests and deploys once the `AZURE_STATIC_WEB_APPS_API_TOKEN` secret is set.

## Baseline

This repository starts from ENGAGE v132 (issued 17 November 2026). The first
commit's build is byte-identical to `Engage_Interface_Tool_v132.html`
(sha256 `2cae3e12530d2e29d6497dfd634a9256a0626a53c026bb08bcad9ed52dfc53a8`).
Check it with `python3 tools/build.py --check path/to/Engage_Interface_Tool_v132.html`.
