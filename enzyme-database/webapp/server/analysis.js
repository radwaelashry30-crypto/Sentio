'use strict';

const { contingencyTable, chiSquareTest, pearsonCorrelation } = require('./stats');

function toArrayParam(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Applies the sidebar filter set to the canonical record list.
 * filters: { kingdom, family, genus, species, acceptorClass, donor, donorRole,
 *   metal, regioPosition, host, yearFrom, yearTo, completeness, promiscuousDmapp,
 *   search, includeMissing }
 */
function applyFilters(records, filters = {}) {
  const kingdom = toArrayParam(filters.kingdom);
  const family = toArrayParam(filters.family);
  const genus = toArrayParam(filters.genus);
  const species = toArrayParam(filters.species);
  const acceptorClass = toArrayParam(filters.acceptorClass);
  const donor = toArrayParam(filters.donor);
  const metal = toArrayParam(filters.metal);
  const regioPosition = toArrayParam(filters.regioPosition);
  const host = toArrayParam(filters.host);
  const completeness = toArrayParam(filters.completeness);
  const donorRole = filters.donorRole || 'accepted'; // 'primary' | 'accepted'
  const includeMissing = filters.includeMissing !== 'false' && filters.includeMissing !== false;
  const yearFrom = filters.yearFrom ? Number(filters.yearFrom) : null;
  const yearTo = filters.yearTo ? Number(filters.yearTo) : null;
  const promiscuousDmapp = filters.promiscuousDmapp === 'true' || filters.promiscuousDmapp === true;
  const search = (filters.search || '').trim().toLowerCase();

  function passesSet(recValue, set, allowMissing) {
    if (!set || set.length === 0) return true;
    if (recValue == null) return allowMissing;
    return set.includes(recValue);
  }
  function passesSetMulti(recValues, set, allowMissing) {
    if (!set || set.length === 0) return true;
    if (!recValues || recValues.length === 0) return allowMissing;
    return recValues.some((v) => set.includes(v));
  }

  return records.filter((r) => {
    if (kingdom && kingdom.length && !kingdom.includes('All') && !kingdom.includes(r.origin)) return false;
    if (!passesSet(r.family, family, includeMissing)) return false;
    if (!passesSet(r.genus, genus, includeMissing)) return false;
    if (!passesSet(r.species, species, includeMissing)) return false;
    if (!passesSet(r.acceptorClass, acceptorClass, includeMissing)) return false;
    const donorValues = donorRole === 'primary' ? (r.primaryDonor ? [r.primaryDonor] : []) : r.allAcceptedDonors;
    if (!passesSetMulti(donorValues, donor, includeMissing)) return false;
    if (!passesSetMulti(r.acceptedMetals, metal, includeMissing)) return false;
    if (!passesSetMulti(r.regioPositions, regioPosition, includeMissing)) return false;
    if (!passesSet(r.expressionHost, host, includeMissing)) return false;
    if (!passesSet(r.dataCompleteness, completeness, includeMissing)) return false;
    if (promiscuousDmapp && !r.promiscuousDmapp) return false;
    if (yearFrom != null && (r.year == null || r.year < yearFrom)) return false;
    if (yearTo != null && (r.year == null || r.year > yearTo)) return false;

    if (search) {
      const haystack = [
        r.enzyme, r.organism, r.family, r.genus, r.species, r.acceptorClass,
        r.author, r.doi, r.product, ...(r.acceptedAcceptors || []), ...(r.allAcceptedDonors || []),
        r.organismRaw, r.acceptorClassRaw,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function distinctSorted(values) {
  return [...new Set(values.filter((v) => v != null && v !== ''))].sort((a, b) =>
    String(a).localeCompare(String(b))
  );
}

/** Cascading filter option lists, computed from a record set already narrowed
 *  by every OTHER active filter (so options always reflect what's reachable). */
function filterOptions(records) {
  return {
    kingdom: ['Plant', 'Fungal'],
    family: distinctSorted(records.map((r) => r.family)),
    genus: distinctSorted(records.map((r) => r.genus)),
    species: distinctSorted(records.map((r) => r.species)),
    acceptorClass: distinctSorted(records.map((r) => r.acceptorClass)),
    donor: distinctSorted(records.flatMap((r) => r.allAcceptedDonors)),
    metal: distinctSorted(records.flatMap((r) => r.acceptedMetals)),
    regioPosition: distinctSorted(records.flatMap((r) => r.regioPositions)),
    host: distinctSorted(records.map((r) => r.expressionHost)),
    completeness: distinctSorted(records.map((r) => r.dataCompleteness)),
    yearMin: Math.min(...records.map((r) => r.year).filter(Number.isFinite)),
    yearMax: Math.max(...records.map((r) => r.year).filter(Number.isFinite)),
  };
}

function kpis(records) {
  const plant = records.filter((r) => r.origin === 'Plant');
  const fungal = records.filter((r) => r.origin === 'Fungal');
  const years = records.map((r) => r.year).filter(Number.isFinite);
  const families = distinctSorted(plant.map((r) => r.family));
  const genera = distinctSorted(plant.map((r) => r.genus));
  const acceptorClasses = distinctSorted(records.map((r) => r.acceptorClass));
  const withBothKm = records.filter(
    (r) => r.kmEntries.some((k) => k.role === 'donor') && r.kmEntries.some((k) => k.role === 'acceptor')
  ).length;
  return {
    total: records.length,
    plant: plant.length,
    fungal: fungal.length,
    plantFamilies: families.length,
    plantGenera: genera.length,
    acceptorClasses: acceptorClasses.length,
    yearMin: years.length ? Math.min(...years) : null,
    yearMax: years.length ? Math.max(...years) : null,
    enzymesWithFullKmPair: withBothKm,
  };
}

function topOf(counts) {
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return entries.length ? { value: entries[0][0], count: entries[0][1] } : null;
}

/** Fast-read highlights for the Overview tab: leaderboard-style top values,
 *  computed live from whatever record set is passed (no stored constants). */
function highlights(records) {
  const acceptorCounts = new Map();
  const familyCounts = new Map();
  const donorCounts = new Map();
  const metalCounts = new Map();
  let cPos = 0, oPos = 0;
  records.forEach((r) => {
    if (r.acceptorClass) acceptorCounts.set(r.acceptorClass, (acceptorCounts.get(r.acceptorClass) || 0) + 1);
    if (r.family) familyCounts.set(r.family, (familyCounts.get(r.family) || 0) + 1);
    new Set(r.allAcceptedDonors).forEach((d) => donorCounts.set(d, (donorCounts.get(d) || 0) + 1));
    new Set(r.acceptedMetals).forEach((m) => metalCounts.set(m, (metalCounts.get(m) || 0) + 1));
    if (r.regioPositions?.some((p) => p.startsWith('C'))) cPos++;
    else if (r.regioPositions?.some((p) => p.startsWith('O'))) oPos++;
  });
  const complete = records.filter((r) => r.dataCompleteness === 'complete').length;
  const promiscuousCount = records.filter((r) => r.promiscuousDmapp).length;
  const ahpt1 = records.find((r) => r.enzyme === 'AhPT1');

  return {
    topAcceptorClass: topOf(acceptorCounts),
    topFamily: topOf(familyCounts),
    topDonor: topOf(donorCounts),
    topMetal: topOf(metalCounts),
    cPrenylationCount: cPos,
    oPrenylationCount: oPos,
    completeRecords: complete,
    totalRecords: records.length,
    promiscuousDmappCount: promiscuousCount,
    hasAhpt1SpecialCase: !!ahpt1?.cofactorConditions,
  };
}

/** One of the 6 plant / 6 fungal bivariate analyses.
 *  groupBy: 'family' | 'genus'; dimension: 'enzymeCount' | 'acceptorClass' | 'donor' */
function bivariate(records, origin, groupBy, dimension) {
  const subset = records.filter((r) => r.origin === origin);
  const groupField = (r) => r[groupBy];

  if (dimension === 'enzymeCount') {
    const counts = new Map();
    subset.forEach((r) => {
      const g = groupField(r);
      if (g == null) return;
      counts.set(g, (counts.get(g) || 0) + 1);
    });
    const total = subset.length;
    const rows = [...counts.entries()]
      .map(([group, count]) => ({ group, count, percent: total ? (count / total) * 100 : 0 }))
      .sort((a, b) => b.count - a.count);
    return { groupBy, dimension, unit: 'records', denominator: total, rows };
  }

  const useEntities = dimension === 'donor';
  const rows = [];
  const denomByGroup = new Map();
  subset.forEach((r) => {
    const g = groupField(r);
    if (g == null) return;
    denomByGroup.set(g, (denomByGroup.get(g) || 0) + 1);
  });

  const cellCounts = new Map(); // key: group|value -> count
  subset.forEach((r) => {
    const g = groupField(r);
    if (g == null) return;
    const values = dimension === 'acceptorClass'
      ? (r.acceptorClass ? [r.acceptorClass] : [])
      : r.allAcceptedDonors;
    const seen = new Set();
    values.forEach((v) => {
      if (seen.has(v)) return; // count each enzyme once per (group,value) pair
      seen.add(v);
      const key = `${g}||${v}`;
      cellCounts.set(key, (cellCounts.get(key) || 0) + 1);
    });
  });

  for (const [key, count] of cellCounts.entries()) {
    const [group, value] = key.split('||');
    const denom = denomByGroup.get(group) || 0;
    rows.push({ group, value, count, denominator: denom, percent: denom ? (count / denom) * 100 : 0 });
  }
  rows.sort((a, b) => a.group.localeCompare(b.group) || b.count - a.count);
  return { groupBy, dimension, unit: useEntities ? 'parsed-entities' : 'records', rows };
}

const BIVARIATE_SPECS = [
  ['family', 'enzymeCount'], ['family', 'acceptorClass'], ['family', 'donor'],
  ['genus', 'enzymeCount'], ['genus', 'acceptorClass'], ['genus', 'donor'],
];

function allBivariate(records) {
  const out = { plant: {}, fungal: {} };
  for (const origin of ['Plant', 'Fungal']) {
    const key = origin.toLowerCase();
    for (const [groupBy, dimension] of BIVARIATE_SPECS) {
      out[key][`${groupBy}_${dimension}`] = bivariate(records, origin, groupBy, dimension);
    }
  }
  return out;
}

function statisticalAnalysis(records) {
  const kingdomAcceptor = chiSquareTest(
    contingencyTable(records, (r) => r.origin, (r) => r.acceptorClass)
  );
  const kingdomDonor = chiSquareTest(
    contingencyTable(
      records.flatMap((r) => r.allAcceptedDonors.map((d) => ({ origin: r.origin, donor: d }))),
      (r) => r.origin, (r) => r.donor
    )
  );
  const kmPairs = records
    .map((r) => {
      const donorKm = r.kmEntries.find((k) => k.role === 'donor');
      const acceptorKm = r.kmEntries.find((k) => k.role === 'acceptor');
      return donorKm && acceptorKm ? [Math.log10(donorKm.valueUM), Math.log10(acceptorKm.valueUM)] : null;
    })
    .filter(Boolean);
  const kmCorrelation = pearsonCorrelation(kmPairs);

  const phByOrigin = { Plant: [], Fungal: [] };
  const tempByOrigin = { Plant: [], Fungal: [] };
  records.forEach((r) => {
    if (r.ph.valid && r.ph.mid != null) phByOrigin[r.origin]?.push(r.ph.mid);
    if (r.temp.valid && r.temp.mid != null) tempByOrigin[r.origin]?.push(r.temp.mid);
  });

  const missingness = {
    donorKm: records.filter((r) => !r.kmEntries.some((k) => k.role === 'donor')).length,
    acceptorKm: records.filter((r) => !r.kmEntries.some((k) => k.role === 'acceptor')).length,
    ph: records.filter((r) => !r.ph.valid).length,
    temperature: records.filter((r) => !r.temp.valid).length,
    total: records.length,
  };

  return {
    kingdomVsAcceptorClass: { ...kingdomAcceptor, label: "Kingdom × Acceptor class (χ², Cramér's V)" },
    kingdomVsDonor: { ...kingdomDonor, label: "Kingdom × Prenyl donor, parsed-entity level (χ², Cramér's V)" },
    donorAcceptorKmCorrelation: { ...kmCorrelation, label: 'log10(Donor Km) vs log10(Acceptor Km), Pearson r' },
    phByOrigin: summarizeNumeric(phByOrigin),
    tempByOrigin: summarizeNumeric(tempByOrigin),
    missingness,
  };
}

function summarizeNumeric(byOrigin) {
  const out = {};
  for (const [origin, values] of Object.entries(byOrigin)) {
    if (values.length === 0) { out[origin] = { n: 0 }; continue; }
    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    out[origin] = {
      n: values.length,
      mean: round2(mean),
      median: round2(sorted[Math.floor(sorted.length / 2)]),
      min: round2(sorted[0]),
      max: round2(sorted[sorted.length - 1]),
    };
  }
  return out;
}
function round2(n) { return Math.round(n * 100) / 100; }

/** Data-grounded observations, explicitly labeled as computed (not claims). */
function biologicalInsights(records) {
  const stats = statisticalAnalysis(records);
  const insights = [];

  if (stats.kingdomVsAcceptorClass.pValue != null) {
    const s = stats.kingdomVsAcceptorClass;
    insights.push({
      kingdom: 'both',
      text: `Computed observation: kingdom (plant vs. fungal) and acceptor class are associated in this dataset (χ²=${round2(s.chi2)}, df=${s.df}, p=${s.pValue < 0.0001 ? '<0.0001' : round2(s.pValue)}, Cramér's V=${round2(s.cramersV)}, n=${s.n}).`,
    });
  }

  const donorByOrigin = { Plant: new Map(), Fungal: new Map() };
  records.forEach((r) => r.allAcceptedDonors.forEach((d) => {
    const m = donorByOrigin[r.origin];
    if (m) m.set(d, (m.get(d) || 0) + 1);
  }));
  for (const origin of ['Plant', 'Fungal']) {
    const entries = [...donorByOrigin[origin].entries()].sort((a, b) => b[1] - a[1]);
    if (entries.length) {
      insights.push({
        kingdom: origin.toLowerCase(),
        text: `Computed observation: the most frequently accepted prenyl donor among ${origin.toLowerCase()} records is ${entries[0][0]} (${entries[0][1]} of ${records.filter((r) => r.origin === origin).length} ${origin.toLowerCase()} records).`,
      });
    }
  }

  const promiscuous = records.filter((r) => r.promiscuousDmapp);
  if (promiscuous.length) {
    insights.push({
      kingdom: 'both',
      text: `Computed observation: ${promiscuous.length} record(s) are heuristically flagged as promiscuous DMAPP acceptors (DMAPP accepted + ≥4 distinct accepted aromatic substrates): ${promiscuous.map((r) => r.enzyme).join(', ')}. Flag is a deterministic rule over existing fields, not a literature claim — see manual-review list.`,
    });
  }

  return insights;
}

/** Acceptor class × Regio position — the two axes are always kept together
 *  so a regio position is never presented without which acceptor class it
 *  belongs to (Flavonoid C3 and Coumarin C3 stay distinct cells, never
 *  summed into one "C3" total). */
function regioByAcceptorClass(records) {
  const cellCounts = new Map(); // "acceptorClass||position" -> count
  const classDenominator = new Map();
  records.forEach((r) => {
    if (!r.acceptorClass || !r.regioPositions.length) return;
    classDenominator.set(r.acceptorClass, (classDenominator.get(r.acceptorClass) || 0) + 1);
    const seen = new Set();
    r.regioPositions.forEach((pos) => {
      if (seen.has(pos)) return;
      seen.add(pos);
      const key = `${r.acceptorClass}||${pos}`;
      cellCounts.set(key, (cellCounts.get(key) || 0) + 1);
    });
  });
  const rows = [];
  for (const [key, count] of cellCounts.entries()) {
    const [acceptorClass, regioPosition] = key.split('||');
    const denom = classDenominator.get(acceptorClass) || 0;
    rows.push({ acceptorClass, regioPosition, count, denominator: denom, percent: denom ? (count / denom) * 100 : 0 });
  }
  rows.sort((a, b) => a.acceptorClass.localeCompare(b.acceptorClass) || b.count - a.count);
  return { unit: 'records (record counted once per distinct position within its own acceptor class)', rows };
}

function literature(records) {
  const byYear = new Map();
  records.forEach((r) => {
    if (r.year == null) return;
    byYear.set(r.year, (byYear.get(r.year) || 0) + 1);
  });
  const trend = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count }));
  const items = records.map((r) => ({
    id: r.id, enzyme: r.enzyme, author: r.author, year: r.year, doi: r.doi, origin: r.origin,
  }));
  return { trend, items };
}

module.exports = {
  applyFilters, filterOptions, kpis, allBivariate, bivariate, statisticalAnalysis,
  biologicalInsights, literature, distinctSorted, regioByAcceptorClass, highlights,
};
