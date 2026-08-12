# Enzyme Database

## [`dist/enzyme-database.html`](dist/enzyme-database.html) — the deliverable

One self-contained HTML file. Double-click it, or drop it on any static
host — no server, no `npm install`, no internet connection needed (every
library it uses is bundled inside the file itself). Not published/hosted
anywhere; it's yours to keep, share as a file, or host later if you want to.

It has the **full feature set** of the original live-server dashboard
(`webapp/`, see below) — all tabs and analyses:

- **Overview** — live status, KPI cards, top-value highlights, special-case flags.
- **EDA** — kingdom/year/host/family/donor/metal/pH/temperature/regiospecificity charts (Plotly).
- **Data Cleaning & Parsing** — the full normalization audit log and manual-review list.
- **Bivariate Analysis** — family/genus × acceptor-class/donor heatmaps and cross-tabs, Km scatter, regio heatmap.
- **Statistical Analysis** — real chi-square, Cramér's V, and Pearson r, computed in the browser.
- **Biological Insights** — data-grounded computed observations.
- **Literature Analysis** — publication-year trend and per-record author/DOI table.
- **Record Browser** — sortable, paginated, click-to-expand full detail per record.
- **Ask the Data** — free local keyword search (English + a small Arabic term bridge), no external API.
- **+ Add Record** — a form that appends one new enzyme record at a time, going through the exact same validation/normalization pipeline as a file upload.
- **Upload / Replace Data** — load a different .xlsx/.csv entirely.
- **Export Full Workbook (.xlsx)** and **Export filtered records (CSV)** — get your data back out, including anything you've added.

Ships pre-loaded with the current dataset (185 records). Anything you
add/upload is kept in this browser's local storage so it survives a reload;
**Reset to Baseline** clears that and reloads the bundled dataset. There is
no login and no shared/multi-user state — this is a private, single-browser
copy, matching the "not published" requirement.

### How this works technically

This page is the same frontend as `webapp/` (`public/index.html` + `app.js`
+ `styles.css`, byte-for-byte, unmodified) talking to what it thinks is a
backend. There is no backend: `full/shim.js` intercepts every
`fetch('/api/...')`, the one XHR upload call, and the WebSocket connection,
and answers them **synchronously in the browser** using the exact same
analysis/normalization/statistics code the server used
(`webapp/server/{analysis,stats,search,ingest/*}.js`, mechanically ported
— requires/module.exports stripped, logic untouched — by
`full/port-server-modules.js` into `full/ported-server.js`, and verified
byte-for-byte identical output against the originals by
`full/verify-port.js`).

### Rebuilding after an edit

If you change `webapp/server/{analysis,stats,search,ingest/*}.js` or
`webapp/public/*`:

```bash
cd enzyme-database/full
node port-server-modules.js   # only needed if webapp/server/* changed
node build.js                 # always run this to refold dist/enzyme-database.html
```

To bake in a different baseline dataset (so the page opens pre-loaded with
it, instead of needing an upload):

```bash
cd enzyme-database
npm install xlsx --prefix full   # one-off, only to run regen-data.js
node full/regen-data.js "data/YOUR_FILE.xlsx"
node full/build.js
```

---

## [`webapp/`](webapp/) — the original live-server version

The Node/Express backend this was ported from: a real filesystem watcher
(edit the source file, dashboard updates live), WebSocket push, and a true
shared canonical dataset — useful if you ever want that instead of a
single-browser copy. Runs locally via `npm start` (`cd webapp && npm
install && npm start`, then open `http://localhost:5173`) — also not
deployed/published anywhere; see [`webapp/README.md`](webapp/README.md).

Kept here as the source of truth for the analysis/normalization logic that
`dist/enzyme-database.html` ports from — if you need genuinely live
multi-tab/multi-person updates rather than a single portable file, this is
the one to run instead.
