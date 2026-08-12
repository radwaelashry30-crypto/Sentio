'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { parseWorkbookFile } = require('./parseWorkbook');
const { validateWorkbook } = require('./validate');
const { normalizeDataset } = require('./normalize');
const { commitVersion } = require('../db');

function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/**
 * Runs the full ingest pipeline for one file: parse -> validate -> normalize
 * -> commit. Every stage is reported through onStage(stageName) so callers
 * (the watcher, the upload route) can broadcast lifecycle status. Nothing is
 * written to the canonical store unless validation AND normalization succeed
 * — an invalid file simply throws IngestError and the previously committed
 * (last valid) version stays active untouched.
 */
class IngestError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'IngestError';
    this.details = details || [];
  }
}

async function ingestFile(filePath, sourceFilename, onStage = () => {}) {
  onStage('validating');
  const hash = fileHash(filePath);

  let parsed;
  try {
    parsed = parseWorkbookFile(filePath);
  } catch (err) {
    throw new IngestError(`Could not parse file: ${err.message}`, [err.message]);
  }

  const validation = validateWorkbook(parsed);
  if (!validation.ok) {
    throw new IngestError('File failed structural validation.', validation.errors);
  }

  onStage('parsing');
  const { records, auditLog, manualReview } = normalizeDataset(parsed.rows);

  if (records.length === 0) {
    throw new IngestError('No records survived normalization.', ['Zero valid records after cleaning.']);
  }

  onStage('updating_analysis');
  const version = commitVersion({
    fileHash: hash,
    sourceFilename,
    rawRows: parsed.rows,
    records,
    auditLog,
    manualReview,
  });

  onStage('updated');
  return { version, recordCount: records.length, fileHash: hash, sourceFilename };
}

module.exports = { ingestFile, IngestError, fileHash };
