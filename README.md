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
| `tools/build.py` | Joins the above into one file, `dist/Engage.html` |

## Build

```
python3 tools/build.py
```

Open `dist/Engage.html` in a browser. Never edit `dist/` by hand; edit `src/` or
`data/` and rebuild.

## Baseline

This repository starts from ENGAGE v132 (issued 17 November 2026). The first
commit's build is byte-identical to `Engage_Interface_Tool_v132.html`
(sha256 `2cae3e12530d2e29d6497dfd634a9256a0626a53c026bb08bcad9ed52dfc53a8`).
Check it with `python3 tools/build.py --check path/to/Engage_Interface_Tool_v132.html`.
