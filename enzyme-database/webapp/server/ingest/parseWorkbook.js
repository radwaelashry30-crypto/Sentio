'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { parse: parseCsvSync } = require('csv-parse/sync');

/**
 * Reads an .xlsx or .csv file into an array of row objects keyed by the
 * (trimmed) header text. Blank trailing columns (no header text) and blank
 * trailing rows (no value in any cell) are dropped.
 */
function parseWorkbookFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let grid;

  if (ext === '.csv') {
    const raw = fs.readFileSync(filePath, 'utf8');
    grid = parseCsvSync(raw, { relax_column_count: true, skip_empty_lines: false });
  } else if (ext === '.xlsx' || ext === '.xls') {
    const wb = XLSX.readFile(filePath, { cellDates: false });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  } else {
    throw new Error(`Unsupported file type: ${ext}. Only .xlsx and .csv are accepted.`);
  }

  if (!grid || grid.length === 0) {
    throw new Error('File is empty.');
  }

  const headerRow = grid[0].map((h) => (h == null ? '' : String(h).trim()));
  const columnIndexes = [];
  headerRow.forEach((h, i) => {
    if (h !== '') columnIndexes.push(i);
  });

  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const rawRow = grid[r] || [];
    const isBlank = columnIndexes.every((i) => {
      const v = rawRow[i];
      return v === null || v === undefined || String(v).trim() === '';
    });
    if (isBlank) continue;

    const obj = { __sourceRow: r + 1 }; // 1-indexed spreadsheet row number, header is row 1
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

module.exports = { parseWorkbookFile };
