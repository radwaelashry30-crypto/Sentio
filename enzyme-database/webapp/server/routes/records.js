'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { stringify } = require('csv-stringify/sync');
const store = require('../store');
const { applyFilters } = require('../analysis');
const { getActiveRawRows } = require('../db');
const { REQUIRED_COLUMNS } = require('../ingest/constants');
const { ingestFile, IngestError } = require('../ingest/pipeline');

const router = express.Router();

// Maps the "Add a new enzyme record" form's field names to the exact source
// workbook column names, so a manually added record goes through the exact
// same parse -> validate -> normalize -> commit pipeline as any uploaded file.
const FORM_FIELD_TO_COLUMN = {
  enzyme: 'Enzyme',
  acceptorClass: 'Acceptor class',
  family: 'Family',
  origin: 'Origin',
  organism: 'Gene from organism',
  acceptorAccepted: 'Prenyl acceptor (Aromatic substrate) - Accepted',
  acceptorMedium: 'Prenyl acceptor (Aromatic substrate) - Medium to Not Accepted',
  donorAccepted: 'Prenyl donor - Accepted',
  donorMedium: 'Prenyl donor - Medium to Not Accepted',
  metalAccepted: 'Metal ion - Accepted',
  metalMedium: 'Metal ion - Medium to Not Accepted',
  expressionHost: 'Expression in',
  product: 'Product',
  regio: 'Regio specificity',
  km: 'Km value',
  ph: 'Optimal pH',
  temperature: 'Optimal temperature',
  year: 'Year',
  author: 'Author',
  doi: 'doi',
};

const uploadsDir = path.join(__dirname, '..', '..', 'data', 'uploads');

router.post('/add', express.json(), async (req, res) => {
  const body = req.body || {};
  const enzyme = (body.enzyme || '').trim();
  const origin = (body.origin || '').trim().toUpperCase();
  if (!enzyme) return res.status(400).json({ ok: false, error: 'Enzyme name is required.' });
  if (origin !== 'P' && origin !== 'F') return res.status(400).json({ ok: false, error: 'Origin must be Plant or Fungal.' });

  try {
    const existingRows = getActiveRawRows();
    const maxSno = existingRows.reduce((max, r) => Math.max(max, Number(r['S. No.']) || 0), 0);
    const nextSno = maxSno + 1;

    const newRow = { 'S. No.': nextSno };
    for (const [formField, column] of Object.entries(FORM_FIELD_TO_COLUMN)) {
      const val = body[formField];
      newRow[column] = (val == null || String(val).trim() === '') ? null : val;
    }
    newRow['Origin'] = origin;
    newRow['Enzyme'] = enzyme;

    const allRows = [...existingRows, newRow];
    const aoa = [REQUIRED_COLUMNS, ...allRows.map((r) => REQUIRED_COLUMNS.map((col) => r[col] ?? null))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Tabelle1');

    fs.mkdirSync(uploadsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tempPath = path.join(uploadsDir, `${stamp}__manual-add-${enzyme.replace(/[^a-z0-9]/gi, '_')}.xlsx`);
    XLSX.writeFile(wb, tempPath);

    const result = await ingestFile(tempPath, path.basename(tempPath), (stage) => store.setStage(stage));
    store.applyNewVersion(result);
    res.json({
      ok: true, version: result.version, recordCount: result.recordCount, newSno: nextSno,
      refreshedAt: store.state.lastRefreshAt,
    });
  } catch (err) {
    if (err instanceof IngestError) {
      store.setError(err.message, err.details);
      return res.status(422).json({ ok: false, error: err.message, details: err.details });
    }
    store.setError(err.message, []);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

function paginate(records, req) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
  const start = (page - 1) * pageSize;
  return { page, pageSize, total: records.length, rows: records.slice(start, start + pageSize) };
}

router.get('/', (req, res) => {
  const filtered = applyFilters(store.state.records, req.query);
  const sortField = req.query.sortField || 'id';
  const sortDir = req.query.sortDir === 'desc' ? -1 : 1;
  const sorted = [...filtered].sort((a, b) => {
    const av = a[sortField]; const bv = b[sortField];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir;
    return String(av).localeCompare(String(bv)) * sortDir;
  });
  const result = paginate(sorted, req);
  res.json(result);
});

router.get('/entities/:kind', (req, res) => {
  const filtered = applyFilters(store.state.records, req.query);
  const kind = req.params.kind;
  let rows = [];
  if (kind === 'donors') {
    rows = filtered.flatMap((r) => r.allAcceptedDonors.map((d) => ({ recordId: r.id, enzyme: r.enzyme, origin: r.origin, donor: d })));
  } else if (kind === 'metals') {
    rows = filtered.flatMap((r) => r.acceptedMetals.map((m) => ({ recordId: r.id, enzyme: r.enzyme, origin: r.origin, metal: m })));
  } else if (kind === 'acceptors') {
    rows = filtered.flatMap((r) => r.acceptedAcceptors.map((a) => ({ recordId: r.id, enzyme: r.enzyme, origin: r.origin, acceptor: a })));
  } else {
    return res.status(400).json({ error: `Unknown entity kind "${kind}"` });
  }
  res.json({ total: rows.length, rows });
});

router.get('/export.csv', (req, res) => {
  const filtered = applyFilters(store.state.records, req.query);
  const rows = filtered.map((r) => ({
    id: r.id, enzyme: r.enzyme, origin: r.origin, acceptorClass: r.acceptorClass, family: r.family,
    genus: r.genus, species: r.species, expressionHost: r.expressionHost, year: r.year,
    primaryDonor: r.primaryDonor, allAcceptedDonors: r.allAcceptedDonors.join('; '),
    acceptedMetals: r.acceptedMetals.join('; '), regio: r.regioTokens.join('; '),
    ph: r.ph.mid, temperature: r.temp.mid, dataCompleteness: r.dataCompleteness,
    promiscuousDmapp: r.promiscuousDmapp, author: r.author, year_2: r.year, doi: r.doi,
    sourceRow: r.sourceRow,
  }));
  const csv = stringify(rows, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="pt-atlas-filtered-records.csv"');
  res.send(csv);
});

router.get('/:id', (req, res) => {
  const rec = store.state.records.find((r) => String(r.id) === req.params.id);
  if (!rec) return res.status(404).json({ error: 'Record not found' });
  const raw = require('../db').getDb()
    .prepare('SELECT raw_json FROM raw_rows WHERE version = ? AND sno = ?')
    .get(store.state.meta.version, rec.id);
  res.json({ record: rec, raw: raw ? JSON.parse(raw.raw_json) : null });
});

module.exports = router;
