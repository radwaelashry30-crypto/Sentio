'use strict';

// Minimal, dependency-free statistics: contingency tables, chi-square,
// Cramer's V, and a chi-square upper-tail p-value via the regularized
// incomplete gamma function (Numerical-Recipes-style series/continued
// fraction). Good to ~1e-10 relative error, ample for reporting p-values.

function logGamma(x) {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function lowerIncompleteGammaSeries(a, x) {
  let sum = 1 / a;
  let term = sum;
  for (let n = 1; n < 500; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function upperIncompleteGammaCF(a, x) {
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Regularized upper incomplete gamma Q(a, x) = 1 - P(a, x). */
function gammaQ(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;
  if (x < a + 1) return 1 - lowerIncompleteGammaSeries(a, x);
  return upperIncompleteGammaCF(a, x);
}

/** Upper-tail p-value for a chi-square statistic with df degrees of freedom. */
function chiSquarePValue(chi2, df) {
  if (chi2 <= 0 || df <= 0) return 1;
  return Math.max(0, Math.min(1, gammaQ(df / 2, chi2 / 2)));
}

/** Builds a contingency table (rows x cols) of counts from records. */
function contingencyTable(records, rowField, colField) {
  const rowVals = [];
  const colVals = [];
  const rowIndex = new Map();
  const colIndex = new Map();
  const counts = [];

  for (const rec of records) {
    const rv = rowField(rec);
    const cv = colField(rec);
    if (rv == null || cv == null) continue;
    if (!rowIndex.has(rv)) {
      rowIndex.set(rv, rowVals.length);
      rowVals.push(rv);
      counts.push([]);
    }
    if (!colIndex.has(cv)) {
      colIndex.set(cv, colVals.length);
      colVals.push(cv);
    }
    const ri = rowIndex.get(rv);
    const ci = colIndex.get(cv);
    counts[ri][ci] = (counts[ri][ci] || 0) + 1;
  }
  for (const row of counts) {
    for (let c = 0; c < colVals.length; c++) row[c] = row[c] || 0;
  }
  return { rowVals, colVals, counts };
}

function chiSquareTest(table) {
  const { rowVals, colVals, counts } = table;
  const rowTotals = counts.map((row) => row.reduce((a, b) => a + b, 0));
  const colTotals = colVals.map((_, c) => counts.reduce((a, row) => a + row[c], 0));
  const n = rowTotals.reduce((a, b) => a + b, 0);
  if (n === 0 || rowVals.length < 2 || colVals.length < 2) {
    return { chi2: null, df: null, pValue: null, cramersV: null, n };
  }
  let chi2 = 0;
  for (let r = 0; r < rowVals.length; r++) {
    for (let c = 0; c < colVals.length; c++) {
      const expected = (rowTotals[r] * colTotals[c]) / n;
      if (expected > 0) chi2 += (counts[r][c] - expected) ** 2 / expected;
    }
  }
  const df = (rowVals.length - 1) * (colVals.length - 1);
  const pValue = chiSquarePValue(chi2, df);
  const minDim = Math.min(rowVals.length - 1, colVals.length - 1);
  const cramersV = minDim > 0 ? Math.sqrt(chi2 / (n * minDim)) : null;
  return { chi2, df, pValue, cramersV, n };
}

function pearsonCorrelation(pairs) {
  const clean = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const n = clean.length;
  if (n < 3) return { r: null, n };
  const meanX = clean.reduce((s, [a]) => s + a, 0) / n;
  const meanY = clean.reduce((s, [, b]) => s + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (const [a, b] of clean) {
    num += (a - meanX) * (b - meanY);
    denX += (a - meanX) ** 2;
    denY += (b - meanY) ** 2;
  }
  const r = denX > 0 && denY > 0 ? num / Math.sqrt(denX * denY) : null;
  return { r, n };
}

module.exports = { contingencyTable, chiSquareTest, pearsonCorrelation, chiSquarePValue };
