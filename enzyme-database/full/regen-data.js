#!/usr/bin/env node
'use strict';
// Regenerates src/data.json (the dataset baked into the page as the default
// on first open) from a source .xlsx/.csv workbook. Run `node full/build.js`
// afterwards to fold the new data.json into dist/enzyme-database.html.
//
// Usage: node full/regen-data.js "data/YOUR_FILE.xlsx"   (run from enzyme-database/)
// Requires the `xlsx` npm package installed locally (only for this one-off
// script — the shipped page itself needs no build tooling).

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const REQUIRED_COLUMNS = [
  'S. No.', 'Enzyme', 'Acceptor class', 'Family', 'Origin', 'Gene from organism',
  'Prenyl acceptor (Aromatic substrate) - Accepted',
  'Prenyl acceptor (Aromatic substrate) - Medium to Not Accepted',
  'Prenyl donor - Accepted', 'Prenyl donor - Medium to Not Accepted',
  'Metal ion - Accepted', 'Metal ion - Medium to Not Accepted',
  'Expression in', 'Product', 'Regio specificity', 'Km value',
  'Optimal pH', 'Optimal temperature', 'Year', 'Author', 'doi',
];

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node regen-data.js "data/YOUR_FILE.xlsx"');
  process.exit(1);
}

const wb = XLSX.readFile(inputPath);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
const cleaned = rows
  .map((r) => { const out = {}; REQUIRED_COLUMNS.forEach((c) => { out[c] = r[c] === undefined ? null : r[c]; }); return out; })
  .filter((r) => r['Enzyme'] || r['S. No.']);

const outPath = path.join(__dirname, '..', 'src', 'data.json');
fs.writeFileSync(outPath, JSON.stringify(cleaned));
console.log(`Wrote ${cleaned.length} rows to ${outPath}. Now run: node full/build.js`);
