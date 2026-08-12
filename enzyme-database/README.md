# Enzyme Database

Two ways to browse, filter, and extend the plant/fungal prenyltransferase
(PT) enzyme dataset. Neither is deployed/published anywhere — both are for
running privately, either on your own machine or as a standalone file.

## [`webapp/`](webapp/) — the full dashboard (recommended)

The complete dashboard, all tabs and analyses: Overview, EDA, Data Cleaning
& Parsing, Bivariate Analysis, Statistical Analysis, Biological Insights,
Literature Analysis, Record Browser, Ask the Data, + Add Record. Runs
locally via `npm start` (`cd webapp && npm install && npm start`, then open
`http://localhost:5173`) — a real backend with a filesystem watcher,
live-updating charts, and file upload, but **only reachable on your own
machine** unless you deliberately deploy it yourself. See
[`webapp/README.md`](webapp/README.md) for full details.

## [`dist/enzyme-database.html`](dist/enzyme-database.html) — single-file fallback

A lighter alternative with no install step at all: one self-contained HTML
file, open it by double-clicking, no server, no `npm install`. Fewer
analysis tabs than `webapp/` (no bivariate/statistical/literature views),
but the same core filtering, family/genus/compound breakdowns, typo
detection, add-record form, and Excel/CSV export. Useful if you want to
hand someone a single file with zero setup instead of running a server.

---

## `dist/` details

**Open it**: double-click [`dist/enzyme-database.html`](dist/enzyme-database.html),
or drop it on any static file host. It works straight from `file://`.

### What it does

- Loads the bundled baseline dataset (185 records from
  `data/List of PTs_20260806_plant and fungal.xlsx`) automatically on open.
- **Load Excel / CSV** — replace the working dataset with your own file (same
  column layout as the source workbook).
- **Filters**: kingdom (Plant/Fungal), family, genus, acceptor class
  (compound converted), prenyl donor, metal ion/cofactor, and free-text
  search — all cascading and combinable.
- **Overview**: enzyme counts per plant/fungal family, per compound
  (acceptor) class, and per genus, at a glance.
- **Families & Genera**: full sortable breakdown of every family/genus
  researched so far, with enzyme and family/genus counts.
- **Compound Lookup**: pick an acceptor class or donor and get every enzyme
  that converts/accepts it.
- **Data Quality**: flags exact duplicate rows and *possible* typos — pairs
  of family/genus/organism names that are suspiciously close (edit
  distance) to each other, e.g. a misspelled genus. These are flags for a
  human to check, not automatic corrections — nothing is changed silently.
- **Record Browser**: sortable, searchable table with a click-to-expand full
  detail view per record.
- **+ Add Record**: a form that appends one new enzyme record at a time
  (mirrors the workbook's columns). Warns if the family/genus you typed
  looks like a near-duplicate/typo of an existing one, or if the record
  looks like an exact duplicate — but adds it either way, so you decide.
- **Export Excel (.xlsx) / Export CSV**: downloads the *current* full
  dataset (baseline + everything you've added) in the same column layout as
  the source workbook.

### Persistence

Because there is no server, added/edited records are kept in this browser's
`localStorage` (key `enzymeDb.rows.v1`) so they survive a page reload. They
are **not** synced anywhere else — if you switch browsers/machines, or clear
site data, export a file first. **Clear data** wipes local storage and
reverts to the bundled baseline dataset.

### Expected column layout

Same headers as the source PT workbook (order-independent):

```
S. No. | Enzyme | Acceptor class | Family | Origin (P/F) | Gene from organism |
Prenyl acceptor (Aromatic substrate) - Accepted |
Prenyl acceptor (Aromatic substrate) - Medium to Not Accepted |
Prenyl donor - Accepted | Prenyl donor - Medium to Not Accepted |
Metal ion - Accepted | Metal ion - Medium to Not Accepted |
Expression in | Product | Regio specificity | Km value |
Optimal pH | Optimal temperature | Year | Author | doi
```

### Rebuilding after an edit

Source files live in `src/` (`index.html`, `app.js`, `styles.css`) plus
`vendor/xlsx.full.min.js` and `src/data.json` (the bundled baseline dataset,
generated once from the workbook in `data/`). To rebuild the single
deliverable file after changing anything in `src/`:

```bash
node build.js
```

This concatenates everything into `dist/enzyme-database.html` — the only
file that needs to be shared or hosted.

To regenerate `src/data.json` from an updated baseline workbook (so the page
ships with new data pre-loaded, instead of requiring an upload on first
open):

```bash
npm install xlsx   # one-off, only needed to run regen-data.js
node regen-data.js "data/YOUR_FILE.xlsx"
node build.js
```

(The `xlsx` npm package is only needed locally to run this one-off
regeneration script — the shipped page itself needs no build tooling.)

### Known limitations vs. the earlier live-server dashboard (`pt-dashboard`)

This was deliberately built as a static, no-hosting alternative, so a few
things are traded off on purpose:

- **No automatic file-watching.** A browser tab can't watch files on disk;
  loading a new file always requires the explicit **Load Excel / CSV**
  button.
- **No shared/multi-user dataset.** Added records live in *your* browser's
  local storage only, not a shared database. Export and pass the file along
  to share it with someone else.
- **Simplified parsing.** pH/temperature plausibility swap-correction, Km
  unit parsing, regio-position canonicalization, and the few hand-curated
  special cases (e.g. AhPT1's dual-cofactor row) from `pt-dashboard` were
  intentionally left out to keep this a single dependency-light file; those
  fields are shown as raw text in the Record Browser detail view instead of
  being parsed/validated.
- **Typo detection is a flag, not a fix.** Edit-distance similarity is
  heuristic — it will flag both real typos (e.g. "sampsonii" vs "samposii")
  and legitimately similar-but-different names (e.g. two real family names
  that happen to be a couple of letters apart). Always verify before editing
  the source data.

### Dependency note

Bundles SheetJS's `xlsx` package **from the public npm registry** (currently
carries two disclosed advisories — prototype pollution and ReDoS — that
SheetJS has only patched on their own CDN, which wasn't reachable from the
environment this was built in). Since this page only ever parses a file you
yourself choose to load (never arbitrary network input), the practical risk
is low — same reasoning `pt-dashboard`'s README documents for the same
library. If you can reach `cdn.sheetjs.com` from wherever you rebuild this,
swap `vendor/xlsx.full.min.js` for the patched build from
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` and rerun
`node build.js`.
