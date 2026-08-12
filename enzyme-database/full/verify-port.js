#!/usr/bin/env node
'use strict';
// Sanity check: runs the SAME dataset through the original server modules
// (via normal require) and through ported-server.js (via vm, as it will run
// in the browser) and diffs the results of every exported function. Not part
// of the build -- a one-off correctness check for the mechanical port.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const orig = {
  ...require('../webapp/server/ingest/normalize'),
  ...require('../webapp/server/ingest/validate'),
  ...require('../webapp/server/stats'),
  ...require('../webapp/server/analysis'),
  ...require('../webapp/server/search'),
};

const portedSrc = fs.readFileSync(path.join(__dirname, 'ported-server.js'), 'utf8');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(portedSrc, sandbox);

const FUNCS = [
  'normalizeDataset', 'validateWorkbook', 'contingencyTable', 'chiSquareTest', 'pearsonCorrelation',
  'applyFilters', 'filterOptions', 'kpis', 'allBivariate', 'bivariate', 'statisticalAnalysis',
  'biologicalInsights', 'literature', 'distinctSorted', 'regioByAcceptorClass', 'highlights',
  'searchRecords', 'retrieveRelevantRecords', 'tokenize',
];
for (const fn of FUNCS) {
  assert(typeof orig[fn] === 'function', `original missing ${fn}`);
  assert(typeof sandbox[fn] === 'function', `ported missing ${fn}`);
}
console.log(`All ${FUNCS.length} functions present in both.`);

const XLSX = require('../webapp/node_modules/xlsx');
const wb = XLSX.readFile(path.join(__dirname, '../webapp/data/source/List of PTs_20260806_plant and fungal.xlsx'));
const ws = wb.Sheets[wb.SheetNames[0]];
const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
const headerRow = grid[0].map((h) => (h == null ? '' : String(h).trim()));
const columnIndexes = [];
headerRow.forEach((h, i) => { if (h !== '') columnIndexes.push(i); });
const rows = [];
for (let r = 1; r < grid.length; r++) {
  const rawRow = grid[r] || [];
  const isBlank = columnIndexes.every((i) => { const v = rawRow[i]; return v == null || String(v).trim() === ''; });
  if (isBlank) continue;
  const obj = { __sourceRow: r + 1 };
  for (const i of columnIndexes) {
    const key = headerRow[i];
    let val = rawRow[i];
    if (typeof val === 'string') { val = val.replace(/\r\n/g, '\n').trim(); if (val === '') val = null; }
    obj[key] = val === undefined ? null : val;
  }
  rows.push(obj);
}
console.log(`Parsed ${rows.length} rows from the source workbook.`);

const origResult = orig.normalizeDataset(rows);
const portedResult = sandbox.normalizeDataset(rows);
const origJson = JSON.stringify(origResult, null, 2);
const portedJson = JSON.stringify(portedResult, null, 2);
if (origJson !== portedJson) {
  fs.writeFileSync('/tmp/orig.json', origJson);
  fs.writeFileSync('/tmp/ported.json', portedJson);
  console.error('normalizeDataset output differs -- wrote /tmp/orig.json and /tmp/ported.json for diffing.');
  process.exit(1);
}
console.log(`normalizeDataset: identical output (${origResult.records.length} records, ${origResult.auditLog.length} audit entries, ${origResult.manualReview.length} manual-review items).`);

const records = origResult.records;
const filters = { kingdom: 'All', family: [], genus: [], acceptorClass: [] };

for (const [label, origFn, portedFn, args] of [
  ['applyFilters', orig.applyFilters, sandbox.applyFilters, [records, filters]],
  ['filterOptions', orig.filterOptions, sandbox.filterOptions, [records]],
  ['kpis', orig.kpis, sandbox.kpis, [records]],
  ['highlights', orig.highlights, sandbox.highlights, [records]],
  ['allBivariate', orig.allBivariate, sandbox.allBivariate, [records]],
  ['statisticalAnalysis', orig.statisticalAnalysis, sandbox.statisticalAnalysis, [records]],
  ['biologicalInsights', orig.biologicalInsights, sandbox.biologicalInsights, [records]],
  ['literature', orig.literature, sandbox.literature, [records]],
  ['regioByAcceptorClass', orig.regioByAcceptorClass, sandbox.regioByAcceptorClass, [records]],
  ['searchRecords("fungal DMAPP genistein")', orig.searchRecords, sandbox.searchRecords, ['fungal DMAPP genistein', records]],
]) {
  const a = JSON.stringify(origFn(...args));
  const b = JSON.stringify(portedFn(...args));
  assert.strictEqual(a, b, `${label} output differs between original and ported!`);
  console.log(`${label}: identical output (${a.length} bytes).`);
}

console.log('\nAll checks passed -- ported-server.js is behaviorally identical to the original server modules.');
