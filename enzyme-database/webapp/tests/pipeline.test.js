'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Isolated DB per test run so this suite never touches the dev canonical store.
process.env.PT_DB_PATH = path.join(os.tmpdir(), `pt-dashboard-test-${process.pid}-${Date.now()}.sqlite`);

const test = require('node:test');
const assert = require('node:assert/strict');
const { ingestFile, IngestError } = require('../server/ingest/pipeline');
const { getActiveVersionMeta, loadActiveDataset } = require('../server/db');

const BASELINE_PATH = path.join(__dirname, '..', 'data', 'source', 'List of PTs_20260806_plant and fungal.xlsx');

test('ingesting the baseline .xlsx commits version 1 with the expected counts', async () => {
  const result = await ingestFile(BASELINE_PATH, 'baseline.xlsx');
  assert.equal(result.recordCount, 185);
  const meta = getActiveVersionMeta();
  assert.equal(meta.record_count, 185);
  assert.equal(meta.plant_count, 137);
  assert.equal(meta.fungal_count, 48);
});

test('an equivalent CSV export of the same data ingests to the same record count', async () => {
  const { parseWorkbookFile } = require('../server/ingest/parseWorkbook');
  const { stringify } = require('csv-stringify/sync');
  const parsed = parseWorkbookFile(BASELINE_PATH);
  const csv = stringify(parsed.rows.map((r) => {
    const { __sourceRow, ...rest } = r;
    return rest;
  }), { header: true });
  const csvPath = path.join(os.tmpdir(), `pt-baseline-${Date.now()}.csv`);
  fs.writeFileSync(csvPath, csv);

  const result = await ingestFile(csvPath, 'baseline.csv');
  assert.equal(result.recordCount, 185);
  fs.unlinkSync(csvPath);
});

test('a valid replacement file becomes the new active version and old version is superseded', async () => {
  const before = getActiveVersionMeta();
  const result = await ingestFile(BASELINE_PATH, 'baseline-reupload.xlsx');
  const after = getActiveVersionMeta();
  assert.ok(after.version > before.version);
  assert.equal(after.status, 'active');
  const ds = loadActiveDataset();
  assert.equal(ds.records.length, 185);
});

test('an invalid file is rejected and the last valid dataset remains active (rollback)', async () => {
  const beforeMeta = getActiveVersionMeta();
  const badPath = path.join(os.tmpdir(), `pt-bad-${Date.now()}.csv`);
  fs.writeFileSync(badPath, 'Foo,Bar\n1,2\n');

  await assert.rejects(() => ingestFile(badPath, 'bad.csv'), IngestError);

  const afterMeta = getActiveVersionMeta();
  assert.equal(afterMeta.version, beforeMeta.version, 'active version must be unchanged after a failed ingest');
  assert.equal(afterMeta.record_count, 185);
  fs.unlinkSync(badPath);
});

test('an empty-but-valid-headers file is rejected rather than silently emptying the dataset', async () => {
  const { parseWorkbookFile } = require('../server/ingest/parseWorkbook');
  const parsed = parseWorkbookFile(BASELINE_PATH);
  const { stringify } = require('csv-stringify/sync');
  const csv = stringify([], { header: true, columns: parsed.headers });
  const emptyPath = path.join(os.tmpdir(), `pt-empty-${Date.now()}.csv`);
  fs.writeFileSync(emptyPath, csv);

  const beforeMeta = getActiveVersionMeta();
  await assert.rejects(() => ingestFile(emptyPath, 'empty.csv'), IngestError);
  const afterMeta = getActiveVersionMeta();
  assert.equal(afterMeta.version, beforeMeta.version);
  fs.unlinkSync(emptyPath);
});

test.after(() => {
  try { fs.unlinkSync(process.env.PT_DB_PATH); } catch {}
  try { fs.unlinkSync(process.env.PT_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(process.env.PT_DB_PATH + '-shm'); } catch {}
});
