'use strict';
/*
 * Browser replacement for the pt-dashboard Node/Express backend. Everything
 * public/app.js normally gets from `fetch('/api/...')`, an XHR upload, or a
 * WebSocket push, is served here instead by computing directly on an
 * in-memory dataset with the SAME analysis/normalize/stats/search functions
 * the server used (ported unchanged into this page by port-server-modules.js
 * -- see ported-server.js, loaded just before this file).
 *
 * Load order in the final page: xlsx vendor -> plotly vendor -> ported-server.js
 * -> this file -> public/app.js (unmodified). app.js's boot() runs
 * synchronously on load and immediately calls fetch('/api/dataset/status'),
 * so window.fetch/XMLHttpRequest/WebSocket must already be overridden, and
 * the initial dataset already loaded, before app.js's <script> tag runs.
 */

// REQUIRED_COLUMNS comes from ported-server.js (ingest/constants.js), loaded
// just before this file -- not redeclared here to avoid a duplicate-const
// SyntaxError that would silently kill this whole script.

const FORM_FIELD_TO_COLUMN = {
  enzyme: 'Enzyme', acceptorClass: 'Acceptor class', family: 'Family', origin: 'Origin',
  organism: 'Gene from organism',
  acceptorAccepted: 'Prenyl acceptor (Aromatic substrate) - Accepted',
  acceptorMedium: 'Prenyl acceptor (Aromatic substrate) - Medium to Not Accepted',
  donorAccepted: 'Prenyl donor - Accepted', donorMedium: 'Prenyl donor - Medium to Not Accepted',
  metalAccepted: 'Metal ion - Accepted', metalMedium: 'Metal ion - Medium to Not Accepted',
  expressionHost: 'Expression in', product: 'Product', regio: 'Regio specificity', km: 'Km value',
  ph: 'Optimal pH', temperature: 'Optimal temperature', year: 'Year', author: 'Author', doi: 'doi',
};

const STORAGE_KEY = 'ptAtlas.rawRows.v1';
const STORAGE_META_KEY = 'ptAtlas.meta.v1';

// ---------------------------------------------------------------------------
// Non-cryptographic string/byte hash (cyrb53-style) -- purely a cosmetic
// "file hash" display value, not a security control, so no Web Crypto
// dependency (keeps this working on file:// without secure-context caveats).
// ---------------------------------------------------------------------------
function simpleHash(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input)
    : new TextEncoder().encode(typeof input === 'string' ? input : JSON.stringify(input));
  let h1 = 0xdeadbeef ^ bytes.length, h2 = 0x41c6ce57 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(16).padStart(16, '0').slice(0, 16);
}

// ---------------------------------------------------------------------------
// In-memory "canonical store" -- replaces server/db.js (SQLite) with a plain
// object. `commitVersion` mirrors db.js's contract exactly.
// ---------------------------------------------------------------------------
const AppDB = {
  nextVersion: 1,
  state: { version: null, meta: null, records: [], rawRows: [], auditLog: [], manualReview: [] },
  commitVersion({ fileHash, sourceFilename, rawRows, records, auditLog, manualReview }) {
    const version = this.nextVersion++;
    const plantCount = records.filter((r) => r.origin === 'Plant').length;
    const fungalCount = records.filter((r) => r.origin === 'Fungal').length;
    this.state = {
      version,
      meta: {
        version, file_hash: fileHash, source_filename: sourceFilename, record_count: records.length,
        plant_count: plantCount, fungal_count: fungalCount, ingested_at: new Date().toISOString(), status: 'active',
      },
      records, rawRows, auditLog, manualReview,
    };
    return version;
  },
};

// ---------------------------------------------------------------------------
// In-process "store" -- replaces server/store.js's EventEmitter with the same
// state shape and methods, minus events (nothing here needs to subscribe;
// dataset changes are pushed to app.js via the fake WebSocket instead, see
// notifyDatasetUpdated below).
// ---------------------------------------------------------------------------
const Store = {
  state: { status: 'idle', records: [], auditLog: [], manualReview: [], meta: null, lastError: null, lastRefreshAt: null, activityLog: [] },
  setStage(stage) { this.state.status = stage; },
  pushActivity(message) {
    this.state.activityLog.unshift({ at: new Date().toISOString(), message });
    this.state.activityLog = this.state.activityLog.slice(0, 50);
  },
  applyNewVersion({ version }) {
    const ds = AppDB.state;
    this.state.records = ds.records;
    this.state.auditLog = ds.auditLog;
    this.state.manualReview = ds.manualReview;
    this.state.meta = ds.meta;
    this.state.status = 'updated';
    this.state.lastError = null;
    this.state.lastRefreshAt = new Date().toISOString();
    this.pushActivity(`Dataset updated to version ${version}: ${ds.meta.source_filename} (${ds.meta.record_count} records, ${ds.meta.plant_count} plant / ${ds.meta.fungal_count} fungal).`);
    persistRawRows();
    notifyDatasetUpdated(ds.meta);
  },
  setError(message, details) {
    this.state.status = 'error';
    this.state.lastError = { message, details: details || [] };
    this.pushActivity(`Error: ${message} — last valid dataset preserved.`);
    notifyError(message, details);
  },
};

function persistRawRows() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(AppDB.state.rawRows));
    localStorage.setItem(STORAGE_META_KEY, JSON.stringify({ sourceFilename: AppDB.state.meta?.source_filename || null }));
  } catch (e) { /* storage full/unavailable -- non-fatal, dataset just won't survive a reload */ }
}

// ---------------------------------------------------------------------------
// Browser file parsing -- replaces server/ingest/parseWorkbook.js's
// fs.readFileSync + XLSX.readFile with XLSX.read() on an in-memory
// ArrayBuffer. SheetJS auto-detects .xlsx vs. plain CSV content either way,
// so both extensions go through the same code path. The grid -> row-object
// logic below (blank trailing column/row handling, __sourceRow numbering) is
// copied unchanged from parseWorkbook.js.
// ---------------------------------------------------------------------------
function parseWorkbookBuffer(arrayBuffer, filename) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
    throw new Error(`Unsupported file type: ${ext}. Only .xlsx and .csv are accepted.`);
  }
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  if (!grid || grid.length === 0) throw new Error('File is empty.');

  const headerRow = grid[0].map((h) => (h == null ? '' : String(h).trim()));
  const columnIndexes = [];
  headerRow.forEach((h, i) => { if (h !== '') columnIndexes.push(i); });

  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const rawRow = grid[r] || [];
    const isBlank = columnIndexes.every((i) => {
      const v = rawRow[i];
      return v === null || v === undefined || String(v).trim() === '';
    });
    if (isBlank) continue;
    const obj = { __sourceRow: r + 1 };
    for (const i of columnIndexes) {
      const key = headerRow[i];
      let val = rawRow[i];
      if (typeof val === 'string') {
        val = val.replace(/\r\n/g, '\n').trim();
        if (val === '') val = null;
      }
      obj[key] = val === undefined ? null : val;
    }
    rows.push(obj);
  }
  return { headers: headerRow.filter((h) => h !== ''), rows };
}

class IngestError extends Error {
  constructor(message, details) { super(message); this.name = 'IngestError'; this.details = details || []; }
}

// Mirrors server/ingest/pipeline.js's ingestFile: parse -> validate ->
// normalize -> commit, throwing IngestError (last valid dataset stays
// active) on any failure.
async function ingestArrayBuffer(arrayBuffer, sourceFilename, onStage) {
  onStage('validating');
  const hash = simpleHash(arrayBuffer);
  let parsed;
  try {
    parsed = parseWorkbookBuffer(arrayBuffer, sourceFilename);
  } catch (err) {
    throw new IngestError(`Could not parse file: ${err.message}`, [err.message]);
  }
  const validation = validateWorkbook(parsed);
  if (!validation.ok) throw new IngestError('File failed structural validation.', validation.errors);

  onStage('parsing');
  const { records, auditLog, manualReview } = normalizeDataset(parsed.rows);
  if (records.length === 0) throw new IngestError('No records survived normalization.', ['Zero valid records after cleaning.']);

  onStage('updating_analysis');
  const version = AppDB.commitVersion({ fileHash: hash, sourceFilename, rawRows: parsed.rows, records, auditLog, manualReview });
  onStage('updated');
  return { version, recordCount: records.length, fileHash: hash, sourceFilename };
}

// ---------------------------------------------------------------------------
// Add-record -- mirrors server/routes/records.js POST /api/records/add,
// minus the round-trip through a temp .xlsx file (unnecessary here: we
// already have the raw rows in memory, so normalizeDataset runs on them
// directly).
// ---------------------------------------------------------------------------
function handleAddRecord(body) {
  body = body || {};
  const enzyme = (body.enzyme || '').trim();
  const origin = (body.origin || '').trim().toUpperCase();
  if (!enzyme) return jsonResponse({ ok: false, error: 'Enzyme name is required.' }, 400);
  if (origin !== 'P' && origin !== 'F') return jsonResponse({ ok: false, error: 'Origin must be Plant or Fungal.' }, 400);

  try {
    const existingRows = AppDB.state.rawRows;
    const maxSno = existingRows.reduce((max, r) => Math.max(max, Number(r['S. No.']) || 0), 0);
    const nextSno = maxSno + 1;
    const maxSourceRow = existingRows.reduce((max, r) => Math.max(max, Number(r.__sourceRow) || 0), 1);

    const newRow = { 'S. No.': nextSno, __sourceRow: maxSourceRow + 1 };
    for (const [formField, column] of Object.entries(FORM_FIELD_TO_COLUMN)) {
      const val = body[formField];
      newRow[column] = val == null || String(val).trim() === '' ? null : val;
    }
    newRow['Origin'] = origin;
    newRow['Enzyme'] = enzyme;

    const allRows = [...existingRows, newRow];
    const validation = validateWorkbook({ headers: REQUIRED_COLUMNS, rows: allRows });
    if (!validation.ok) throw new IngestError('File failed structural validation.', validation.errors);
    const { records, auditLog, manualReview } = normalizeDataset(allRows);

    const version = AppDB.commitVersion({
      fileHash: simpleHash(JSON.stringify(allRows)),
      sourceFilename: AppDB.state.meta?.source_filename || 'manual-entry',
      rawRows: allRows, records, auditLog, manualReview,
    });
    Store.applyNewVersion({ version });
    return jsonResponse({ ok: true, version, recordCount: records.length, newSno: nextSno, refreshedAt: Store.state.lastRefreshAt });
  } catch (err) {
    if (err instanceof IngestError) {
      Store.setError(err.message, err.details);
      return jsonResponse({ ok: false, error: err.message, details: err.details }, 422);
    }
    Store.setError(err.message, []);
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

// Edits ONE existing record in place -- mirrors server/routes/records.js's
// POST /:id/update. Lets you fix a single field (e.g. one wrong donor value)
// without re-uploading the whole workbook.
function handleUpdateRecord(id, body) {
  body = body || {};
  const enzyme = (body.enzyme || '').trim();
  const origin = (body.origin || '').trim().toUpperCase();
  if (!enzyme) return jsonResponse({ ok: false, error: 'Enzyme name is required.' }, 400);
  if (origin !== 'P' && origin !== 'F') return jsonResponse({ ok: false, error: 'Origin must be Plant or Fungal.' }, 400);

  try {
    const existingRows = AppDB.state.rawRows;
    const idx = existingRows.findIndex((r) => Number(r['S. No.']) === id);
    if (idx === -1) return jsonResponse({ ok: false, error: `No record with S. No. ${id}.` }, 404);

    const updatedRow = { ...existingRows[idx] };
    for (const [formField, column] of Object.entries(FORM_FIELD_TO_COLUMN)) {
      const val = body[formField];
      updatedRow[column] = val == null || String(val).trim() === '' ? null : val;
    }
    updatedRow['Origin'] = origin;
    updatedRow['Enzyme'] = enzyme;

    const allRows = [...existingRows];
    allRows[idx] = updatedRow;
    const validation = validateWorkbook({ headers: REQUIRED_COLUMNS, rows: allRows });
    if (!validation.ok) throw new IngestError('File failed structural validation.', validation.errors);
    const { records, auditLog, manualReview } = normalizeDataset(allRows);

    const version = AppDB.commitVersion({
      fileHash: simpleHash(JSON.stringify(allRows)),
      sourceFilename: AppDB.state.meta?.source_filename || 'manual-entry',
      rawRows: allRows, records, auditLog, manualReview,
    });
    Store.applyNewVersion({ version });
    return jsonResponse({ ok: true, version, recordCount: records.length, updatedSno: id, refreshedAt: Store.state.lastRefreshAt });
  } catch (err) {
    if (err instanceof IngestError) {
      Store.setError(err.message, err.details);
      return jsonResponse({ ok: false, error: err.message, details: err.details }, 422);
    }
    Store.setError(err.message, []);
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

// ---------------------------------------------------------------------------
// fetch() shim -- routes /api/* the same way server/routes/*.js did, computed
// synchronously off Store.state. Everything else (Google Fonts, etc.) passes
// through to the real fetch.
// ---------------------------------------------------------------------------
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function queryToObject(searchParams) {
  const obj = {};
  for (const [k, v] of searchParams.entries()) obj[k] = v;
  return obj;
}
function sortRecords(records, sortField, sortDir) {
  return [...records].sort((a, b) => {
    const av = a[sortField]; const bv = b[sortField];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir;
    return String(av).localeCompare(String(bv)) * sortDir;
  });
}

const originalFetch = window.fetch.bind(window);

window.fetch = async function shimFetch(input, init) {
  const urlStr = typeof input === 'string' ? input : input.url;
  if (!urlStr.startsWith('/api/')) return originalFetch(input, init);

  const url = new URL(urlStr, location.origin);
  const path = url.pathname;
  const query = queryToObject(url.searchParams);
  const method = (init && init.method) || 'GET';

  try {
    if (path === '/api/dataset/status' && method === 'GET') {
      const s = Store.state;
      return jsonResponse({ status: s.status, meta: s.meta, lastRefreshAt: s.lastRefreshAt, lastError: s.lastError, activityLog: s.activityLog.slice(0, 10) });
    }
    if (path === '/api/dataset/summary' && method === 'GET') {
      const filtered = applyFilters(Store.state.records, query);
      return jsonResponse({ kpis: kpis(filtered), kpisUnfiltered: kpis(Store.state.records), highlights: highlights(filtered), meta: Store.state.meta, manualReviewCount: Store.state.manualReview.length });
    }
    if (path === '/api/dataset/filter-options' && method === 'GET') {
      const filtered = applyFilters(Store.state.records, query);
      return jsonResponse(filterOptions(filtered.length ? filtered : Store.state.records));
    }
    if (path === '/api/dataset/manual-review' && method === 'GET') return jsonResponse(Store.state.manualReview);
    if (path === '/api/dataset/audit-log' && method === 'GET') return jsonResponse(Store.state.auditLog);

    if (path === '/api/records' && method === 'GET') {
      const filtered = applyFilters(Store.state.records, query);
      const sorted = sortRecords(filtered, query.sortField || 'id', query.sortDir === 'desc' ? -1 : 1);
      const page = Math.max(1, Number(query.page) || 1);
      const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || 50));
      const start = (page - 1) * pageSize;
      return jsonResponse({ page, pageSize, total: sorted.length, rows: sorted.slice(start, start + pageSize) });
    }
    const entMatch = path.match(/^\/api\/records\/entities\/(\w+)$/);
    if (entMatch && method === 'GET') {
      const filtered = applyFilters(Store.state.records, query);
      const kind = entMatch[1];
      let rows = [];
      if (kind === 'donors') rows = filtered.flatMap((r) => r.allAcceptedDonors.map((d) => ({ recordId: r.id, enzyme: r.enzyme, origin: r.origin, donor: d })));
      else if (kind === 'metals') rows = filtered.flatMap((r) => r.acceptedMetals.map((m) => ({ recordId: r.id, enzyme: r.enzyme, origin: r.origin, metal: m })));
      else if (kind === 'acceptors') rows = filtered.flatMap((r) => r.acceptedAcceptors.map((a) => ({ recordId: r.id, enzyme: r.enzyme, origin: r.origin, acceptor: a })));
      else return jsonResponse({ error: `Unknown entity kind "${kind}"` }, 400);
      return jsonResponse({ total: rows.length, rows });
    }
    const idMatch = path.match(/^\/api\/records\/(\d+)$/);
    if (idMatch && method === 'GET') {
      const rec = Store.state.records.find((r) => String(r.id) === idMatch[1]);
      if (!rec) return jsonResponse({ error: 'Record not found' }, 404);
      const raw = AppDB.state.rawRows.find((r) => String(r['S. No.']) === idMatch[1]) || null;
      return jsonResponse({ record: rec, raw });
    }
    if (path === '/api/records/add' && method === 'POST') return handleAddRecord(JSON.parse(init.body));
    const updateMatch = path.match(/^\/api\/records\/(\d+)\/update$/);
    if (updateMatch && method === 'POST') return handleUpdateRecord(Number(updateMatch[1]), JSON.parse(init.body));

    if (path === '/api/analysis/bivariate' && method === 'GET') return jsonResponse(allBivariate(applyFilters(Store.state.records, query)));
    if (path === '/api/analysis/stats' && method === 'GET') return jsonResponse(statisticalAnalysis(applyFilters(Store.state.records, query)));
    if (path === '/api/analysis/insights' && method === 'GET') return jsonResponse(biologicalInsights(applyFilters(Store.state.records, query)));
    if (path === '/api/analysis/literature' && method === 'GET') return jsonResponse(literature(applyFilters(Store.state.records, query)));
    if (path === '/api/analysis/regio' && method === 'GET') return jsonResponse(regioByAcceptorClass(applyFilters(Store.state.records, query)));
    if (path === '/api/analysis/search' && method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      const question = (body.question || '').trim();
      if (!question) return jsonResponse({ ok: false, error: 'Missing "question" in request body.' }, 400);
      if (question.length > 500) return jsonResponse({ ok: false, error: 'Question is too long (max 500 characters).' }, 400);
      const filtered = applyFilters(Store.state.records, body.filters || {});
      return jsonResponse(searchRecords(question, filtered));
    }
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
  return jsonResponse({ error: `No handler for ${method} ${path}` }, 404);
};

// ---------------------------------------------------------------------------
// XMLHttpRequest shim -- app.js's uploadFile() is the only XHR user, always
// POSTing a FormData to /api/upload. Everything else goes through fetch above.
// ---------------------------------------------------------------------------
const RealXHR = window.XMLHttpRequest;

class ShimXHR extends RealXHR {
  open(method, url, ...rest) {
    this._shimIsUpload = method === 'POST' && url === '/api/upload';
    if (this._shimIsUpload) { this._shimMethod = method; this._shimUrl = url; return; }
    return super.open(method, url, ...rest);
  }
  send(body) {
    if (!this._shimIsUpload) return super.send(body);
    const file = body instanceof FormData ? body.get('file') : null;
    if (!file) {
      queueMicrotask(() => { this.status = 400; this.responseText = JSON.stringify({ error: 'No file uploaded (field name must be "file").' }); this.onload && this.onload(); });
      return;
    }
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      queueMicrotask(() => { this.status = 400; this.responseText = JSON.stringify({ error: 'Only .xlsx and .csv files are accepted.' }); this.onload && this.onload(); });
      return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
      if (this.upload && this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: file.size, total: file.size });
      try {
        const result = await ingestArrayBuffer(e.target.result, file.name, (stage) => Store.setStage(stage));
        Store.applyNewVersion(result);
        this.status = 200;
        this.responseText = JSON.stringify({ ok: true, version: result.version, fileHash: result.fileHash, recordCount: result.recordCount, sourceFilename: result.sourceFilename, refreshedAt: Store.state.lastRefreshAt });
      } catch (err) {
        if (err instanceof IngestError) {
          Store.setError(err.message, err.details);
          this.status = 422;
          this.responseText = JSON.stringify({ ok: false, error: err.message, details: err.details });
        } else {
          Store.setError(err.message, []);
          this.status = 500;
          this.responseText = JSON.stringify({ ok: false, error: err.message });
        }
      }
      this.onload && this.onload();
    };
    reader.onerror = () => { this.status = 0; this.onerror && this.onerror(); };
    reader.readAsArrayBuffer(file);
  }
}
window.XMLHttpRequest = ShimXHR;

// ---------------------------------------------------------------------------
// WebSocket shim -- app.js only ever assigns .onmessage/.onclose and never
// actually needs a live socket; we just need somewhere to deliver a
// synthetic "dataset_updated" event after an upload/add-record commits.
// ---------------------------------------------------------------------------
let currentFakeWs = null;
class FakeWebSocket {
  constructor() { currentFakeWs = this; this.onmessage = null; this.onclose = null; }
  send() {}
  close() {}
}
window.WebSocket = FakeWebSocket;

function notifyDatasetUpdated(meta) {
  if (currentFakeWs && currentFakeWs.onmessage) {
    currentFakeWs.onmessage({ data: JSON.stringify({ type: 'dataset_updated', meta }) });
  }
}
function notifyError(message, details) {
  if (currentFakeWs && currentFakeWs.onmessage) {
    currentFakeWs.onmessage({ data: JSON.stringify({ type: 'error', message, details }) });
  }
}

// ---------------------------------------------------------------------------
// CSV export button -- app.js's handler does
// `window.location.href = '/api/records/export.csv?...'`, which has no
// server to resolve against here. Intercepted at the document capture phase
// (runs before app.js's own bubble-phase listener on the same button, and
// stopPropagation keeps that handler from running at all) and replaced with
// an equivalent client-side CSV build + download, using the exact same
// column shape server/routes/records.js's export.csv produced.
// ---------------------------------------------------------------------------
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function exportFilteredCsv() {
  const filtered = applyFilters(Store.state.records, typeof filters !== 'undefined' ? filters : {});
  const cols = ['id', 'enzyme', 'origin', 'acceptorClass', 'family', 'genus', 'species', 'expressionHost', 'year',
    'primaryDonor', 'allAcceptedDonors', 'acceptedMetals', 'regio', 'ph', 'temperature', 'dataCompleteness',
    'promiscuousDmapp', 'author', 'year_2', 'doi', 'sourceRow'];
  const rows = filtered.map((r) => ({
    id: r.id, enzyme: r.enzyme, origin: r.origin, acceptorClass: r.acceptorClass, family: r.family,
    genus: r.genus, species: r.species, expressionHost: r.expressionHost, year: r.year,
    primaryDonor: r.primaryDonor, allAcceptedDonors: r.allAcceptedDonors.join('; '),
    acceptedMetals: r.acceptedMetals.join('; '), regio: r.regioTokens.join('; '),
    ph: r.ph.mid, temperature: r.temp.mid, dataCompleteness: r.dataCompleteness,
    promiscuousDmapp: r.promiscuousDmapp, author: r.author, year_2: r.year, doi: r.doi, sourceRow: r.sourceRow,
  }));
  const csv = [cols.join(','), ...rows.map((row) => cols.map((c) => csvEscape(row[c])).join(','))].join('\r\n');
  downloadBlob(csv, 'pt-atlas-filtered-records.csv', 'text/csv;charset=utf-8;');
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('#exportCsvBtn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  exportFilteredCsv();
}, true);

// ---------------------------------------------------------------------------
// Full-workbook export -- an extra affordance not in the original UI (that
// version relied on the server holding canonical state); here, since
// everything lives in this browser only, an explicit "download the whole
// updated workbook" button is how you get your added records back out as a
// real .xlsx. Appended into the header next to Upload/Replace Data.
// ---------------------------------------------------------------------------
function exportFullWorkbook() {
  const aoa = [REQUIRED_COLUMNS, ...AppDB.state.rawRows.map((r) => REQUIRED_COLUMNS.map((col) => (r[col] == null ? '' : r[col])))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tabelle1');
  XLSX.writeFile(wb, `enzyme-database-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
function addExportWorkbookButton() {
  const uploadBtn = document.getElementById('uploadBtn');
  if (!uploadBtn) return;
  const btn = document.createElement('button');
  btn.id = 'exportWorkbookBtn';
  btn.className = uploadBtn.className;
  btn.textContent = 'Export Full Workbook (.xlsx)';
  btn.addEventListener('click', exportFullWorkbook);
  uploadBtn.after(btn);
}

// ---------------------------------------------------------------------------
// Clear-data button -- wipes localStorage and reverts to the bundled
// baseline dataset (another affordance the original didn't need, since the
// server held the canonical copy independent of any browser).
// ---------------------------------------------------------------------------
function addClearDataButton() {
  const uploadBtn = document.getElementById('uploadBtn');
  if (!uploadBtn) return;
  const btn = document.createElement('button');
  btn.id = 'clearDataBtn';
  btn.className = uploadBtn.className;
  btn.textContent = 'Reset to Baseline';
  btn.title = 'Discard everything added/uploaded in this browser and reload the bundled baseline dataset.';
  btn.addEventListener('click', () => {
    if (!confirm('Discard all records added or uploaded in this browser, and reload the original bundled dataset? This cannot be undone.')) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_META_KEY);
    location.reload();
  });
  uploadBtn.after(btn);
}

// ---------------------------------------------------------------------------
// Boot: load persisted rawRows (if any) or the embedded baseline dataset,
// normalize, and commit as version 1 -- all BEFORE app.js's boot() (which
// runs synchronously at the bottom of app.js) makes its first fetch() call.
// ---------------------------------------------------------------------------
function loadInitialDataset() {
  let rawRows = null;
  let sourceFilename = 'List of PTs_20260806_plant and fungal.xlsx';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      rawRows = JSON.parse(stored);
      const meta = JSON.parse(localStorage.getItem(STORAGE_META_KEY) || '{}');
      if (meta.sourceFilename) sourceFilename = meta.sourceFilename;
    }
  } catch (e) { /* corrupt storage -- fall through to embedded default */ }

  if (!rawRows) {
    const el = document.getElementById('embedded-dataset');
    if (el) {
      try { rawRows = JSON.parse(el.textContent); } catch (e) { rawRows = null; }
    }
  }
  if (!rawRows || !rawRows.length) return;

  const { records, auditLog, manualReview } = normalizeDataset(rawRows);
  const version = AppDB.commitVersion({ fileHash: simpleHash(JSON.stringify(rawRows)), sourceFilename, rawRows, records, auditLog, manualReview });
  Store.applyNewVersion({ version });
  Store.pushActivity('Loaded dataset into this browser (no server -- everything below runs client-side).');
}

function fixWatchingBadge() {
  const badge = document.getElementById('watchingBadge');
  if (!badge) return;
  badge.classList.remove('watching');
  badge.title = 'This is a static page with no backend -- use "Upload / Replace Data" to load a new file, there is no automatic file watching.';
  badge.innerHTML = 'No file watching (static page)';
}

loadInitialDataset();
document.addEventListener('DOMContentLoaded', () => { addExportWorkbookButton(); addClearDataButton(); fixWatchingBadge(); });
