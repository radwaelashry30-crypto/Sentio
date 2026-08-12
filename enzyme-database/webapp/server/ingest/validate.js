'use strict';

const { REQUIRED_COLUMNS } = require('./constants');

/**
 * Structural validation performed before any normalization. Returns
 * { ok, errors } — errors is non-empty when the file cannot be ingested.
 */
function validateWorkbook({ headers, rows }) {
  const errors = [];

  const normalizedHeaders = headers.map((h) => h.toLowerCase());
  const missing = REQUIRED_COLUMNS.filter(
    (col) => !normalizedHeaders.includes(col.toLowerCase())
  );
  if (missing.length > 0) {
    errors.push(`Missing required column(s): ${missing.join(', ')}`);
  }

  if (rows.length === 0) {
    errors.push('No data rows found (file has a header row but no records).');
  }

  const seenSno = new Set();
  let missingSno = 0;
  let missingEnzyme = 0;
  let missingOrigin = 0;
  rows.forEach((row) => {
    const sno = row['S. No.'];
    if (sno === null || sno === undefined || sno === '') missingSno++;
    else {
      if (seenSno.has(sno)) errors.push(`Duplicate S. No. value: ${sno} (row ${row.__sourceRow})`);
      seenSno.add(sno);
    }
    if (!row['Enzyme']) missingEnzyme++;
    const origin = (row['Origin'] || '').toString().trim().toUpperCase();
    if (origin !== 'P' && origin !== 'F') missingOrigin++;
  });

  if (missingSno > 0) errors.push(`${missingSno} row(s) missing "S. No."`);
  if (missingEnzyme > 0) errors.push(`${missingEnzyme} row(s) missing "Enzyme"`);
  if (missingOrigin > 0) {
    errors.push(
      `${missingOrigin} row(s) have an "Origin" value other than "P" or "F" (plant/fungal only).`
    );
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validateWorkbook };
