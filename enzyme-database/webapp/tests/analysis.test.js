'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseWorkbookFile } = require('../server/ingest/parseWorkbook');
const { normalizeDataset } = require('../server/ingest/normalize');
const { applyFilters, kpis, bivariate } = require('../server/analysis');
const { chiSquareTest, contingencyTable, chiSquarePValue } = require('../server/stats');

const BASELINE_PATH = path.join(__dirname, '..', 'data', 'source', 'List of PTs_20260806_plant and fungal.xlsx');
const { records } = normalizeDataset(parseWorkbookFile(BASELINE_PATH).rows);

test('applyFilters: kingdom=Plant returns only plant records', () => {
  const filtered = applyFilters(records, { kingdom: 'Plant' });
  assert.equal(filtered.length, 137);
  assert.ok(filtered.every((r) => r.origin === 'Plant'));
});

test('applyFilters: acceptorClass filter narrows correctly', () => {
  const filtered = applyFilters(records, { acceptorClass: 'Flavonoid' });
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((r) => r.acceptorClass === 'Flavonoid'));
});

test('applyFilters: year range is inclusive', () => {
  const filtered = applyFilters(records, { yearFrom: 2020, yearTo: 2020 });
  assert.ok(filtered.every((r) => r.year === 2020));
});

test('applyFilters: free-text search matches enzyme name', () => {
  const filtered = applyFilters(records, { search: 'AhPT1' });
  assert.ok(filtered.some((r) => r.enzyme === 'AhPT1'));
});

test('applyFilters: donorRole=primary vs accepted changes which records match a donor filter', () => {
  const primaryOnly = applyFilters(records, { donor: 'GPP', donorRole: 'primary' });
  const acceptedAny = applyFilters(records, { donor: 'GPP', donorRole: 'accepted' });
  assert.ok(acceptedAny.length >= primaryOnly.length);
});

test('kpis: recomputes from whatever record set is passed (no hard-coded numbers)', () => {
  const all = kpis(records);
  assert.equal(all.total, 185);
  const plantOnly = kpis(applyFilters(records, { kingdom: 'Plant' }));
  assert.equal(plantOnly.total, 137);
  assert.equal(plantOnly.fungal, 0);
});

test('bivariate family x acceptorClass never mixes plant and fungal families', () => {
  const table = bivariate(records, 'Plant', 'family', 'acceptorClass');
  const fungalFamilies = new Set(records.filter((r) => r.origin === 'Fungal').map((r) => r.family));
  for (const row of table.rows) {
    assert.ok(!fungalFamilies.has(row.group) || records.some((r) => r.origin === 'Plant' && r.family === row.group),
      `${row.group} should be a plant family in the plant-origin table`);
  }
});

test('bivariate enzyme-count denominators sum to the origin subset size', () => {
  const table = bivariate(records, 'Fungal', 'family', 'enzymeCount');
  const total = table.rows.reduce((s, r) => s + r.count, 0);
  const fungalWithFamily = records.filter((r) => r.origin === 'Fungal' && r.family != null).length;
  assert.equal(total, fungalWithFamily);
});

test('chi-square: independence (uniform 2x2 table) yields a high p-value', () => {
  const fakeRecords = [
    { a: 'x', b: '1' }, { a: 'x', b: '2' }, { a: 'y', b: '1' }, { a: 'y', b: '2' },
    { a: 'x', b: '1' }, { a: 'x', b: '2' }, { a: 'y', b: '1' }, { a: 'y', b: '2' },
  ];
  const table = contingencyTable(fakeRecords, (r) => r.a, (r) => r.b);
  const result = chiSquareTest(table);
  assert.equal(result.chi2, 0);
  assert.equal(result.pValue, 1);
});

test('chi-square: known critical value chi2=3.841, df=1 gives p≈0.05', () => {
  assert.ok(Math.abs(chiSquarePValue(3.841, 1) - 0.05) < 0.001);
});
