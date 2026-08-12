# Prenyltransferase Atlas Dashboard (v3 — live data service, local copy)

> **This copy runs locally only — it is not deployed/published anywhere.**
> Start it with `npm start` and open `http://localhost:5173` on your own
> machine. Nothing here talks to the internet at runtime (both `xlsx` and
> `plotly.js` are vendored locally — see *Local-only changes* below); if you
> ever want a shareable public link, deploy this folder yourself (e.g. to
> Render, using `render.yaml`) — that is a separate, deliberate step, not
> something this checkout does on its own.

A production dashboard for characterized plant and fungal aromatic prenyltransferases (PTs),
rebuilt from the static `PT_dashboard-1.html` prototype into a real application: a backend
ingestion pipeline, a filesystem watcher, WebSocket-pushed live updates, and a frontend that
renders entirely from API calls — there is no dataset embedded in the HTML.

## What actually changed vs. the prototype

The old file had a hard-coded `const DATA = [...]` array and no upload/watch mechanism. This
version replaces that with:

- A Node/Express backend (`server/`) that parses, validates, normalizes, and canonicalizes the
  source workbook, and serves everything over a JSON API.
- A `chokidar` filesystem watcher on `data/incoming/` with debounce + stability checks, so
  editing and saving the source Excel/CSV file refreshes the dashboard automatically.
- A multipart upload endpoint (`POST /api/upload`) for replacing the dataset from the browser,
  with staged validation and rollback on failure.
- A WebSocket channel (`/ws`) that pushes lifecycle events (`watching → change_detected →
  validating → parsing → updating_analysis → updated`, or `error`) and a `dataset_updated`
  event to every open tab.
- A report generator that regenerates `report.md`, `report_summary.json`, and CSV exports after
  every successful ingest.
- `node --test` acceptance tests covering the ingestion pipeline, normalization rules, filtering,
  and statistics.

## A deliberate deviation from the "recommended architecture", and why

The master prompt's recommended stack is FastAPI + pandas/openpyxl + DuckDB/SQLite. **Python
could not be executed in this sandboxed environment** (`python`, `python3`, and `py` all failed
to launch as subprocesses, even via absolute path — everything else, including `node`, `npm`,
and `git`, worked normally). Rather than produce an FastAPI codebase that could not actually be
run or tested here, the backend was built on Node.js instead, which the environment could run:

- **Backend**: Express instead of FastAPI (same role: HTTP API + WebSocket).
- **Ingestion**: SheetJS (`xlsx`, installed from the vendor's own patched CDN build — see
  *Known dependency risk* below) + a hand-rolled `csv-parse`-based CSV reader, instead of
  pandas/openpyxl.
- **Canonical store**: Node's built-in `node:sqlite` (`DatabaseSync`), which ships inside the
  Node binary and needs no native compilation — chosen specifically because `node-gyp` (used to
  build native npm packages like `better-sqlite3`) itself shells out to Python, which was not
  available. This still satisfies "SQLite for canonical and parsed data" from the spec; it's
  just accessed via Node's built-in driver instead of a Python one. It's flagged `Experimental`
  by Node 24 but is stable enough for this dataset size (185 records).
- **Watcher / live updates**: `chokidar` + `ws`, playing the same role as `watchdog` +
  WebSocket/SSE in the recommended stack.
- **Frontend**: a refactored version of the original single HTML file (`public/index.html` +
  `public/app.js` + `public/styles.css`) rather than a React/TypeScript rewrite, per the spec's
  explicit fallback: *"convert the current HTML into modular frontend code while preserving its
  visual design"*. It calls the backend API for all data and events — nothing is embedded.

If Python becomes available in your environment, the `server/ingest/*` modules are small and
isolated enough to port to pandas/openpyxl without touching the frontend contract (the API
routes and JSON shapes would stay the same).

### Known dependency risk

The `xlsx` (SheetJS) package on the public npm registry has two unpatched advisories
(prototype pollution, ReDoS). SheetJS ships the actual fixes only from their own CDN, not npm.
The upstream version of this project installs from
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` instead of the npm registry version to get
those fixes — but that CDN wasn't reachable from the sandboxed environment this local copy was
assembled in, so `package.json` here pins the plain npm registry build (`xlsx@^0.18.5`) instead.
Since this app only ever parses a file you place in `data/incoming/` or upload yourself (not
arbitrary attacker-supplied network input), the residual risk is low — but if you can reach
`cdn.sheetjs.com` from wherever you run this, switching the `xlsx` line in `package.json` back to
the CDN tarball and re-running `npm install` gets you the patched build.

### Local-only changes (this copy)

Two things were changed from the original to make this run with **zero external network calls**
at runtime, since this copy is meant to stay local/private rather than published:

- `xlsx` — pinned to the npm registry build instead of the SheetJS CDN tarball (see above; this
  was a forced substitution, `cdn.sheetjs.com` was unreachable here).
- `plotly.js` — the frontend used to load `plotly.js` from `cdnjs.cloudflare.com` in
  `public/index.html`; that's now vendored locally at `public/vendor/plotly.min.js` and loaded
  from there, so every chart still renders even fully offline.

Everything else (server logic, ingestion pipeline, frontend behavior, tests) is unchanged from
the original.

## Architecture

```
pt-dashboard/
  server/
    index.js            bootstrap: Express app, WebSocket, watcher, startup ingest
    config.js            env-driven config (port, watched folder, debounce)
    db.js                 node:sqlite schema + versioned canonical storage
    store.js                in-process "active dataset" state + event emitter
    ws.js                     WebSocket hub (broadcasts lifecycle/update/error events)
    watcher.js                 chokidar watcher → pipeline → store
    stats.js                    chi-square, Cramér's V, Pearson r (no external stats lib)
    analysis.js                  filtering, cascading filter options, bivariate tables, KPIs
    reportGenerator.js            report.md / report_summary.json / CSV exports
    ingest/
      parseWorkbook.js             .xlsx/.csv → row objects (blank trailing cols/rows dropped)
      validate.js                   required-column + structural checks
      normalize.js                   the full cleaning pipeline (see below)
      pipeline.js                     parse → validate → normalize → commit, or throw
      constants.js                     donor/metal vocabularies, plausibility bounds
    routes/                           dataset, records, analysis, upload endpoints
  public/
    index.html / app.js / styles.css  the dashboard (preserves the original visual language)
  data/
    source/       the originally supplied baseline workbook (used to bootstrap on first run)
    incoming/     WATCHED folder — drop or edit a .xlsx/.csv here for automatic ingestion
    uploads/      archive of files uploaded via the dashboard's Upload button
    canonical/    dataset.sqlite — one immutable version per successful ingest
    reports/      report.md, report_summary.json, CSVs — regenerated after every refresh
  tests/          node:test acceptance tests
```

## Running it

```bash
cd enzyme-database/webapp
npm install
npm start
```

Then open **http://localhost:5173**. On first run it bootstraps from
`data/source/List of PTs_20260806_plant and fungal.xlsx` automatically. After that, whichever
version was last committed to `data/canonical/dataset.sqlite` is what loads.

Run the test suite:

```bash
npm test
```

Regenerate the report bundle by hand (also happens automatically after every refresh):

```bash
npm run report
```

Configuration (all optional, see `.env.example`): `PORT`, `INCOMING_DIR`,
`WATCH_STABILITY_MS`, `WATCH_POLL_MS`.

## The two live-update workflows

### A. Edit the source file and save it

1. Copy or edit an `.xlsx`/`.csv` file in `data/incoming/` (this is the watched folder;
   configurable via `INCOMING_DIR`).
2. Save it normally (Excel's temporary `~$filename.xlsx` lock files are ignored automatically).
3. The backend waits for the file to stop changing for `WATCH_STABILITY_MS` (default 3000ms —
   this is both the debounce and the "stability check" the spec asks for, implemented via
   chokidar's `awaitWriteFinish`), then runs validate → parse → normalize → commit.
4. Every open browser tab receives a `dataset_updated` WebSocket event and re-renders — no
   manual reload.
5. If the file is invalid (missing columns, zero rows, bad Origin values, etc.), the status bar
   shows `Error — last valid dataset preserved`, the previous version stays active, and nothing
   is silently mixed.

### B. Upload/replace through the dashboard

Click **Upload / Replace Data** in the header, pick an `.xlsx` or `.csv` file. A progress bar
tracks the upload; the same validate → normalize → commit pipeline runs server-side, and on
success the new filename, version, hash, and record count appear in the status bar and every
chart/table/statistic updates. On failure, the file is rejected with the specific validation
errors and the active dataset is untouched.

## What was actually verified in this session (not just implemented)

Both workflows above were run for real against a live server with a connected browser tab, not
just code-reviewed:

- **Edit-and-watch**: a copy of the baseline workbook was placed in `data/incoming/` with one
  cell changed (an author string). The server log showed
  `Change detected → validating → parsing → updating_analysis → updated` and committed version
  2; the already-open browser tab (no reload) updated its status bar to version 2 within
  ~5 seconds, confirmed by re-reading the rendered page text.
- **Upload**: a second edited copy was POSTed to `/api/upload` (the same request shape the
  browser's upload button sends) and committed as version 3; the open tab again updated live via
  WebSocket without a reload.
- **Rollback**: a structurally invalid CSV (wrong headers, no valid rows) was dropped into
  `data/incoming/`; the pipeline rejected it, the status bar showed the error, and
  `GET /api/dataset/status` confirmed the active version was still the last valid one (version 3,
  185 records) — not clobbered or mixed.
- All 8 dashboard tabs (Overview, EDA, Data Cleaning & Parsing, Bivariate Analysis, Statistical
  Analysis, Biological Insights, Literature Analysis, Record Browser) were opened in the browser
  preview and produced real, data-driven content with no console errors. The Record Browser's
  row-expand detail view was exercised directly.
- `npm test` (31 tests) passes, covering the acceptance-criteria list in the master prompt.

**Not verified**: the native OS file-picker dialog behind the "Upload / Replace Data" button
could not be driven by the browser-automation tool available in this session (it opens a real
OS dialog, which is outside what the tool can click through). The upload *code path* was
verified via the identical HTTP request the button's JavaScript sends (see above), and the
button/progress-bar/toast UI was read from the rendered page, but the literal click-native-
dialog-pick-a-file sequence was not driven end-to-end by an automated tool.

## Data pipeline & scientific rules (implemented in `server/ingest/normalize.js`)

- **Raw values + source row numbers** are preserved (`raw_rows` table in the SQLite store; every
  record carries `sourceRow`).
- **Genus/species** are split from the organism field; a parenthetical common name (e.g. "Soy
  bean") is captured separately.
- **Origin** (`P`/`F`) is normalized to `Plant`/`Fungal`.
- **Acceptor class** is normalized on capitalization/whitespace only — e.g. `"coumarin"` and
  `"Coumarin"` merge, but `"Alkylated Hyroquinone"` is left distinct from `"Hydroquinone"`
  because that's a spelling difference, not a case/whitespace difference, and the spec
  explicitly restricts normalization to case/whitespace. Every fold is logged to the audit trail
  (visible in the Data Cleaning & Parsing tab and `data/reports/audit_log.csv`).
- **Regiospecificity is never aggregated across acceptor classes**: every regio token stays
  attached to its own record's acceptor class, so e.g. Flavonoid C3 and Coumarin C3 are always
  distinguishable in every table and chart (covered by an automated test).
- **Donor/metal-ion lists** are exploded against a fixed controlled vocabulary (DMAPP, GPP, FPP,
  GGPP, IPP, LPP, NPP, PPP, SPP, PDP, octaprenyl/decaprenyl diphosphate; metal-ion shape like
  `Mg2+`). Both newlines *and* commas are treated as separators (the real data mixes both — see
  records 26, 82, 103–113 below), but text that doesn't match the vocabulary (e.g. "this enzyme
  has a broad specificity") is kept as a note, never invented as a substrate.
- **Aromatic acceptor-substrate names** are exploded on newlines only — chemical names
  legitimately contain commas (e.g. `2',4,4'-trihydroxychalcone`), so splitting those cells on
  commas would corrupt them.
- **Km values**: each `Label: value unit` line is parsed, unit-converted to µM, and classified
  as donor or acceptor Km by matching the label against the donor vocabulary.
- **pH/temperature**: parsed with a standalone-number matcher that ignores digits glued to
  letters (so `"1367TH-4PX"` in `HpPT4px`'s pH cell doesn't get misread as part of a range —
  confirmed by test). Out-of-range values (pH > 14) are swap-corrected against the paired
  temperature field only when doing so makes **both** values plausible (0–14 / 0–100), and the
  correction is logged, never silent. This reproduces both corrections called out in the
  original prototype's changelog (HpPT4px pH 8.0, and the 8 transposed 2026 records
  GgPT1/GgPT4/GinPT1–6) — but as a general rule based on plausibility, not a hard-coded list of
  enzyme names, so it would also catch the same class of error in a future edited file.
- **AhPT1 (S. No. 55)** is a hand-curated exception, not auto-parsed: its source row packs two
  different cofactor conditions (Mg²⁺ vs. Mn²⁺) into ragged parallel line-lists across columns
  that cannot be safely auto-aligned. It's represented as an explicit `cofactorConditions` array
  (Mg²⁺ + genistein → active 6-C-prenylation; Mn²⁺ + 6-hydroxyflavone → active, high conversion;
  Mg²⁺ + 6-hydroxyflavone → undetectable) and flagged in the manual-review list.
- **Promiscuous DMAPP acceptors**: flagged when DMAPP is an accepted donor and the record has ≥4
  distinct accepted aromatic acceptor substrates. This threshold is a stated, deterministic
  heuristic — the prior master prompt and report notes that would define the authoritative rule
  were not part of what was attached to this session, so it's flagged for manual review rather
  than presented as certain.
- **No values are invented.** Unparseable fields are left `null` and excluded pairwise from every
  statistic (see the Missingness panel in Statistical Analysis).

### About "the previous master prompt and report notes"

Section 0 of the attached prompt lists a third input file — "the previous master prompt and the
report notes" — as the source of the scientific cleaning/analysis requirements, but only the PDF
prompt, the HTML prototype, and the workbook were actually attached to this session. The specific
donor-rule records it names (6, 16, 26, 54, 82, 103, 105–107, 109–113, 139, 179, 180, 183, 185,
186, 187) were individually inspected against the real workbook and handled with the general
parsing rules above; S. No. 186 and 187 don't exist in this 185-row file (flagged in manual
review as a likely stale reference from an earlier dataset revision). If the missing prior
document surfaces, its rules should be reconciled against `server/ingest/normalize.js`.

## Scientific records flagged for manual review

Generated fresh on every ingest at `data/reports/manual_review.csv` (19 items on the baseline
file). Summary:

| S. No. | Enzyme | Reason |
|---|---|---|
| 15 | HpPT4px | Enzyme cell contains extra variant text beyond the primary name ("4 long variants…") |
| 15, 18, 24, 61, 64, 65, 117 | HpPT4px, AhR4DT-1, RcDT1, PcPT11, SfFPT, GUILDT, LaPT2 | Heuristic promiscuous-DMAPP flag — confirm against source publication |
| 55 | AhPT1 | Cofactor-dependent activity represented via manual override (see above) — verify against Yang et al. 2020 |
| 175–182 | GgPT1, GgPT4, GinPT1–6 | pH/temperature auto-swap-corrected — verify against source publication |
| 186, 187 | — | Referenced by the prior master prompt's donor-rule list but don't exist in this workbook |

## "Ask the Data" (free keyword search, no external API)

A tab that lets you type a question or a few keywords and get back the matching records, ranked
by relevance, from the currently filtered dataset — searching enzyme name, organism, family,
acceptor class, donors, metals, expression host, author, and DOI (`server/search.js`). The
summary line above the results (match count, plant/fungal split, most common acceptor class and
donor among the matches) is computed directly from the data, not AI-generated. Clicking a result
jumps to that record in the Record Browser.

This runs entirely locally — no external API, no API key, no per-query cost. An earlier version
of this feature called the Claude API for AI-generated, citation-grounded answers (genuine RAG);
that was replaced with this free keyword-search version by request, since a real LLM call is
inherently pay-per-use and there's no way around that. If AI-generated answers are wanted later,
`server/search.js`'s retrieval logic is already structured to be dropped into a prompt for an LLM
call — see the git history for the original `server/rag.js` implementation.

## API surface

`GET /api/dataset/status|summary|filter-options|manual-review|audit-log`,
`GET /api/records`, `GET /api/records/entities/:kind`, `GET /api/records/export.csv`,
`GET /api/records/:id`, `GET /api/analysis/bivariate|stats|insights|literature`,
`POST /api/upload` (multipart, field name `file`), `GET /api/reports/:file`, WebSocket at `/ws`.
All list/summary endpoints accept the same filter query params the sidebar produces (`kingdom`,
`family`, `genus`, `species`, `acceptorClass`, `donor`, `donorRole`, `metal`, `host`, `yearFrom`,
`yearTo`, `completeness`, `promiscuousDmapp`, `search`, `includeMissing`), which is also how the
sidebar's state round-trips through the URL query string for bookmarking/sharing filtered views.

## Browser-only file-watching limitation

A hosted static HTML page cannot silently watch arbitrary files on your computer — no
"File System Access API" trick changes that without an explicit, per-file user permission grant,
and even then it only works in Chromium and only for a file/folder the user explicitly picked in
that tab. This app does **not** implement that fallback: the reliable mechanism is the backend
filesystem watcher (workflow A above) or the explicit upload button (workflow B), both of which
this README's verification section confirms actually work. If a browser-only fallback is wanted
later, the File System Access API (`window.showOpenFilePicker` + polling `file.lastModified`)
would need to be added as an explicitly-labeled optional mode in `public/app.js` — it was not
built here because it wouldn't add real capability beyond what's already verified working.
