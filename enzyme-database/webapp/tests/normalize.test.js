'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseWorkbookFile } = require('../server/ingest/parseWorkbook');
const { validateWorkbook } = require('../server/ingest/validate');
const { normalizeDataset, splitOrganism, parsePhAndTemp } = require('../server/ingest/normalize');

const BASELINE_PATH = path.join(__dirname, '..', 'data', 'source', 'List of PTs_20260806_plant and fungal.xlsx');

function loadBaseline() {
  const parsed = parseWorkbookFile(BASELINE_PATH);
  return normalizeDataset(parsed.rows);
}

test('baseline workbook loads with the expected record/plant/fungal counts', () => {
  const parsed = parseWorkbookFile(BASELINE_PATH);
  assert.equal(parsed.rows.length, 185);
  const { records } = normalizeDataset(parsed.rows);
  assert.equal(records.length, 185);
  assert.equal(records.filter((r) => r.origin === 'Plant').length, 137);
  assert.equal(records.filter((r) => r.origin === 'Fungal').length, 48);
});

test('blank trailing column (22nd, unnamed) is ignored', () => {
  const parsed = parseWorkbookFile(BASELINE_PATH);
  assert.ok(!parsed.headers.includes(''), 'no blank header should survive');
  assert.equal(parsed.headers.length, 21);
  for (const row of parsed.rows.slice(0, 5)) {
    assert.ok(!(undefined in row));
  }
});

test('the baseline file passes structural validation', () => {
  const parsed = parseWorkbookFile(BASELINE_PATH);
  const result = validateWorkbook(parsed);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('special donor-rule records parse their accepted/medium donor lists correctly', () => {
  const { records } = loadBaseline();
  const bySno = (id) => records.find((r) => r.id === id);

  assert.deepEqual(bySno(6).allAcceptedDonors, ['DMAPP']);
  assert.deepEqual(bySno(6).mediumDonors, ['IPP']);

  assert.deepEqual(bySno(26).allAcceptedDonors, ['DMAPP', 'GPP']);
  assert.deepEqual(bySno(26).mediumDonors, ['FPP', 'GGPP', 'PPP']);

  // AtPPT1 (82): medium-donor cell is "GPP, this enzyme has a broad specificity" —
  // GPP must be recovered as a token; the trailing clause must NOT become a token.
  assert.deepEqual(bySno(82).mediumDonors, ['GPP']);
  assert.equal(bySno(82).primaryDonor, 'SPP');

  for (const sno of [103, 105, 106, 107, 109, 110, 111, 112, 113]) {
    const rec = bySno(sno);
    assert.ok(rec.allAcceptedDonors.length > 0, `S.No ${sno} should have at least one accepted donor`);
    assert.ok(rec.allAcceptedDonors.every((d) => !/,/.test(d)), `S.No ${sno} donor tokens must be atomic`);
  }

  for (const sno of [139, 179, 180, 183, 185]) {
    const rec = bySno(sno);
    assert.deepEqual(rec.allAcceptedDonors, ['DMAPP']);
  }
});

test('metal ion tokens preserve canonical mixed case (Mg2+, not MG2+)', () => {
  const { records } = loadBaseline();
  const r = records.find((r) => r.id === 1);
  assert.ok(r.acceptedMetals.includes('Mg2+'));
  assert.ok(!r.acceptedMetals.some((m) => m === m.toUpperCase() && /[A-Z]{2,}/.test(m)));
});

test('AhPT1 is represented as a manually curated cofactor-dependent special case', () => {
  const { records } = loadBaseline();
  const ahpt1 = records.find((r) => r.enzyme === 'AhPT1');
  assert.ok(ahpt1, 'AhPT1 record must exist');
  assert.ok(Array.isArray(ahpt1.cofactorConditions));
  assert.equal(ahpt1.cofactorConditions.length, 3);
  const mgGenistein = ahpt1.cofactorConditions.find((c) => c.metal === 'Mg2+' && c.acceptorSubstrate === 'Genistein');
  assert.equal(mgGenistein.outcome, 'active');
  const mnHydroxyflavone = ahpt1.cofactorConditions.find((c) => c.metal === 'Mn2+');
  assert.equal(mnHydroxyflavone.outcome, 'active-high-conversion');
  const mgHydroxyflavone = ahpt1.cofactorConditions.find((c) => c.metal === 'Mg2+' && c.acceptorSubstrate === '6-hydroxyflavone');
  assert.equal(mgHydroxyflavone.outcome, 'undetectable');
});

test('pH/temperature plausibility swap: HpPT4px (S.No 15) pH is parsed as 8.0, not 4.5', () => {
  const { records } = loadBaseline();
  const rec = records.find((r) => r.id === 15);
  assert.equal(rec.ph.mid, 8);
  assert.equal(rec.temp.mid, 40);
  assert.equal(rec.phTempSwapped, false);
});

test('pH/temperature plausibility swap: the 8 transposed 2026 records (175-182) are swapped back', () => {
  const { records } = loadBaseline();
  for (const sno of [175, 176, 177, 178, 179, 180, 181, 182]) {
    const rec = records.find((r) => r.id === sno);
    assert.equal(rec.phTempSwapped, true, `S.No ${sno} should be flagged as swapped`);
    assert.ok(rec.ph.valid && rec.ph.mid >= 0 && rec.ph.mid <= 14, `S.No ${sno} pH must be plausible after swap`);
    assert.ok(rec.temp.valid && rec.temp.mid >= 0 && rec.temp.mid <= 100, `S.No ${sno} temp must be plausible after swap`);
  }
  const gg1 = records.find((r) => r.id === 175);
  assert.equal(gg1.ph.mid, 8.8);
  assert.equal(gg1.temp.mid, 30);
});

test('regiospecificity is always paired with its own record\'s acceptor class (never aggregated across classes)', () => {
  const { records } = loadBaseline();
  // Two records that share a regio label ("C3") but belong to different acceptor
  // classes must remain distinguishable via acceptorClass on the record itself.
  const c3Records = records.filter((r) => r.regioTokens.includes('C3'));
  const classesForC3 = new Set(c3Records.map((r) => r.acceptorClass));
  assert.ok(classesForC3.size >= 2, 'C3 should appear under more than one acceptor class in this dataset');
  // Every regio-bearing record must carry a non-null acceptor class alongside it.
  for (const r of c3Records) assert.ok(r.acceptorClass, `record ${r.id} has a regio token but no acceptor class`);
});

test('genus/species/common-name extraction from the organism field', () => {
  assert.deepEqual(splitOrganism('Glycine max (Soy bean)'), { genus: 'Glycine', species: 'max', commonName: 'Soy bean', organism: 'Glycine max' });
  assert.equal(splitOrganism('Epimedium sp.').species, null);
  assert.equal(splitOrganism('Aspergillus nidulans').genus, 'Aspergillus');
  assert.equal(splitOrganism('Aspergillus nidulans').species, 'nidulans');
});

test('pH/temp range resolution: "7.5 to 9" becomes low/high/mid', () => {
  const { ph } = parsePhAndTemp('7.5 to 9', null);
  assert.equal(ph.low, 7.5);
  assert.equal(ph.high, 9);
  assert.equal(ph.mid, 8.25);
});

test('standalone-number matcher ignores digits glued to letters (alphanumeric codes)', () => {
  const { ph } = parsePhAndTemp('8 for formation of 1367TH-4PX with v1', '40°C');
  assert.equal(ph.mid, 8);
});

test('acceptor-class normalization only folds capitalization/whitespace, never merges distinct meanings', () => {
  const { records } = loadBaseline();
  const classes = new Set(records.map((r) => r.acceptorClass));
  assert.ok(classes.has('Hydroquinone'));
  assert.ok(classes.has('Alkylated Hyroquinone')); // distinct source spelling, left un-merged by design
});

test('records 186/187 referenced by the (missing) prior master prompt do not exist in this 185-row workbook', () => {
  const { manualReview } = loadBaseline();
  const flagged = manualReview.filter((m) => m.sno === 186 || m.sno === 187);
  assert.equal(flagged.length, 2);
});
