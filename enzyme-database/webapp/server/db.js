'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.PT_DB_PATH
  ? path.resolve(process.env.PT_DB_PATH)
  : path.join(__dirname, '..', 'data', 'canonical', 'dataset.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dataset_versions (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  plant_count INTEGER NOT NULL,
  fungal_count INTEGER NOT NULL,
  ingested_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_rows (
  version INTEGER NOT NULL,
  source_row INTEGER NOT NULL,
  sno INTEGER,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (version, source_row)
);

CREATE TABLE IF NOT EXISTS records (
  version INTEGER NOT NULL,
  id INTEGER NOT NULL,
  source_row INTEGER NOT NULL,
  enzyme TEXT,
  origin TEXT,
  acceptor_class TEXT,
  family TEXT,
  genus TEXT,
  species TEXT,
  expression_host TEXT,
  year INTEGER,
  primary_donor TEXT,
  data_completeness TEXT,
  promiscuous_dmapp INTEGER,
  record_json TEXT NOT NULL,
  PRIMARY KEY (version, id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY (version, seq)
);

CREATE TABLE IF NOT EXISTS manual_review (
  version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY (version, seq)
);
`;

let db = null;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/**
 * Commits a fully-normalized dataset as a new immutable version. This is the
 * only write path — there is no partial/in-place mutation, so a version is
 * either fully present or not created at all (transactional staging happens
 * one level up in pipeline.js, before this is ever called).
 */
function commitVersion({ fileHash, sourceFilename, rawRows, records, auditLog, manualReview }) {
  const database = getDb();
  database.exec('BEGIN');
  try {
    const plantCount = records.filter((r) => r.origin === 'Plant').length;
    const fungalCount = records.filter((r) => r.origin === 'Fungal').length;

    const insertVersion = database.prepare(`
      INSERT INTO dataset_versions (file_hash, source_filename, record_count, plant_count, fungal_count, ingested_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `);
    const info = insertVersion.run(
      fileHash, sourceFilename, records.length, plantCount, fungalCount, new Date().toISOString()
    );
    const version = Number(info.lastInsertRowid);

    database.exec(`UPDATE dataset_versions SET status = 'superseded' WHERE version != ${version} AND status = 'active'`);

    const insertRaw = database.prepare(`INSERT INTO raw_rows (version, source_row, sno, raw_json) VALUES (?, ?, ?, ?)`);
    for (const row of rawRows) {
      insertRaw.run(version, row.__sourceRow, row['S. No.'] ?? null, JSON.stringify(row));
    }

    const insertRecord = database.prepare(`
      INSERT INTO records (version, id, source_row, enzyme, origin, acceptor_class, family, genus, species, expression_host, year, primary_donor, data_completeness, promiscuous_dmapp, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of records) {
      insertRecord.run(
        version, r.id, r.sourceRow, r.enzyme, r.origin, r.acceptorClass, r.family, r.genus, r.species,
        r.expressionHost, r.year, r.primaryDonor, r.dataCompleteness, r.promiscuousDmapp ? 1 : 0,
        JSON.stringify(r)
      );
    }

    const insertAudit = database.prepare(`INSERT INTO audit_log (version, seq, entry_json) VALUES (?, ?, ?)`);
    auditLog.forEach((entry, i) => insertAudit.run(version, i, JSON.stringify(entry)));

    const insertReview = database.prepare(`INSERT INTO manual_review (version, seq, entry_json) VALUES (?, ?, ?)`);
    manualReview.forEach((entry, i) => insertReview.run(version, i, JSON.stringify(entry)));

    database.exec('COMMIT');
    return version;
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

function getActiveVersionMeta() {
  const database = getDb();
  const row = database.prepare(`SELECT * FROM dataset_versions WHERE status = 'active' ORDER BY version DESC LIMIT 1`).get();
  return row || null;
}

function loadVersion(version) {
  const database = getDb();
  const records = database.prepare(`SELECT record_json FROM records WHERE version = ? ORDER BY id`).all(version)
    .map((r) => JSON.parse(r.record_json));
  const auditLog = database.prepare(`SELECT entry_json FROM audit_log WHERE version = ? ORDER BY seq`).all(version)
    .map((r) => JSON.parse(r.entry_json));
  const manualReview = database.prepare(`SELECT entry_json FROM manual_review WHERE version = ? ORDER BY seq`).all(version)
    .map((r) => JSON.parse(r.entry_json));
  const meta = database.prepare(`SELECT * FROM dataset_versions WHERE version = ?`).get(version);
  return { meta, records, auditLog, manualReview };
}

function loadActiveDataset() {
  const meta = getActiveVersionMeta();
  if (!meta) return null;
  return loadVersion(meta.version);
}

function getActiveRawRows() {
  const meta = getActiveVersionMeta();
  if (!meta) return [];
  const database = getDb();
  return database.prepare(`SELECT raw_json FROM raw_rows WHERE version = ? ORDER BY source_row`).all(meta.version)
    .map((r) => JSON.parse(r.raw_json));
}

module.exports = {
  getDb, commitVersion, getActiveVersionMeta, loadVersion, loadActiveDataset, getActiveRawRows, DB_PATH,
};
