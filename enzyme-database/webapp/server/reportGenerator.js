'use strict';

const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');
const { kpis, allBivariate, statisticalAnalysis, biologicalInsights } = require('./analysis');
const config = require('./config');

function round(n, d = 3) {
  if (n == null || Number.isNaN(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function buildSummaryJson(state) {
  const records = state.records;
  const k = kpis(records);
  const stats = statisticalAnalysis(records);
  const insights = biologicalInsights(records);
  return {
    generatedAt: new Date().toISOString(),
    dataset: {
      version: state.meta?.version,
      sourceFilename: state.meta?.source_filename,
      fileHash: state.meta?.file_hash,
      ingestedAt: state.meta?.ingested_at,
    },
    kpis: k,
    statistics: {
      kingdomVsAcceptorClass: {
        chi2: round(stats.kingdomVsAcceptorClass.chi2),
        df: stats.kingdomVsAcceptorClass.df,
        pValue: round(stats.kingdomVsAcceptorClass.pValue, 6),
        cramersV: round(stats.kingdomVsAcceptorClass.cramersV),
        n: stats.kingdomVsAcceptorClass.n,
      },
      kingdomVsDonor: {
        chi2: round(stats.kingdomVsDonor.chi2),
        df: stats.kingdomVsDonor.df,
        pValue: round(stats.kingdomVsDonor.pValue, 6),
        cramersV: round(stats.kingdomVsDonor.cramersV),
        n: stats.kingdomVsDonor.n,
      },
      donorAcceptorKmCorrelation: {
        r: round(stats.donorAcceptorKmCorrelation.r),
        n: stats.donorAcceptorKmCorrelation.n,
      },
      missingness: stats.missingness,
    },
    biologicalInsights: insights.map((i) => i.text),
    manualReviewCount: state.manualReview.length,
    auditLogEntryCount: state.auditLog.length,
  };
}

function mdEscape(s) {
  return String(s ?? '').replace(/\|/g, '\\|');
}

function bivariateToMarkdown(title, table) {
  if (table.dimension === 'enzymeCount') {
    let out = `#### ${title}\n\n| ${table.groupBy} | Enzyme count | % of ${table.denominator} |\n|---|---|---|\n`;
    table.rows.forEach((r) => {
      out += `| ${mdEscape(r.group)} | ${r.count} | ${round(r.percent, 1)}% |\n`;
    });
    return out + '\n';
  }
  let out = `#### ${title} (${table.unit})\n\n| ${table.groupBy} | ${table.dimension} | count | % of group |\n|---|---|---|---|\n`;
  table.rows.slice(0, 200).forEach((r) => {
    out += `| ${mdEscape(r.group)} | ${mdEscape(r.value)} | ${r.count} | ${round(r.percent, 1)}% |\n`;
  });
  return out + '\n';
}

function buildReportMarkdown(state) {
  const records = state.records;
  const k = kpis(records);
  const stats = statisticalAnalysis(records);
  const bivar = allBivariate(records);
  const insights = biologicalInsights(records);
  const meta = state.meta || {};

  let md = `# Prenyltransferase Atlas — Data Report\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `Source file: \`${meta.source_filename || 'n/a'}\` · Version ${meta.version ?? 'n/a'} · Hash \`${meta.file_hash || 'n/a'}\` · Ingested ${meta.ingested_at || 'n/a'}\n\n`;
  md += `## 1. Methodology\n\n`;
  md += `Records are ingested from an .xlsx or .csv workbook, validated for required columns, then normalized: genus/species are split from the organism field, acceptor-class labels are folded on capitalization/whitespace only (never merged across meaning), donor/metal ion lists are exploded from a fixed controlled vocabulary (commas and newlines both treated as separators, non-vocabulary text retained as a note rather than fabricated as a substrate), aromatic-acceptor substrate lists are exploded on newlines only (chemical names may legitimately contain commas), and Km/pH/temperature free text is parsed with unit conversion to µM and plausibility-based range/swap correction (pH 0–14, temperature 0–100 °C). No missing scientific values are invented; unparseable fields are left null and excluded pairwise from statistics.\n\n`;

  md += `## 2. Data dictionary\n\n`;
  md += `| Canonical field | Source column | Notes |\n|---|---|---|\n`;
  md += `| origin | Origin | P → Plant, F → Fungal |\n`;
  md += `| acceptorClass | Acceptor class | capitalization/whitespace normalized, audit-logged |\n`;
  md += `| genus, species | Gene from organism | genus = first token; species = second token if lowercase-initial |\n`;
  md += `| allAcceptedDonors | Prenyl donor - Accepted | exploded against fixed donor vocabulary |\n`;
  md += `| acceptedMetals | Metal ion - Accepted | exploded against metal-ion token shape |\n`;
  md += `| ph, temp | Optimal pH, Optimal temperature | range-resolved, plausibility swap-corrected |\n`;
  md += `| kmEntries | Km value | one entry per "Label: value unit" line, role = donor/acceptor |\n\n`;

  md += `## 3. KPIs\n\n`;
  md += `- Total records: **${k.total}** (${k.plant} plant, ${k.fungal} fungal)\n`;
  md += `- Plant families: ${k.plantFamilies} · Plant genera: ${k.plantGenera}\n`;
  md += `- Distinct acceptor classes: ${k.acceptorClasses}\n`;
  md += `- Publication span: ${k.yearMin}–${k.yearMax}\n`;
  md += `- Enzymes with both donor and acceptor Km numerically extractable: ${k.enzymesWithFullKmPair}\n\n`;

  md += `## 4. Statistical analysis (recomputed live from the active dataset)\n\n`;
  const s1 = stats.kingdomVsAcceptorClass;
  md += `- Kingdom × Acceptor class: χ² = ${round(s1.chi2)}, df = ${s1.df}, p = ${s1.pValue < 0.0001 ? '<0.0001' : round(s1.pValue, 6)}, Cramér's V = ${round(s1.cramersV)}, n = ${s1.n}\n`;
  const s2 = stats.kingdomVsDonor;
  md += `- Kingdom × Prenyl donor (parsed-entity level): χ² = ${round(s2.chi2)}, df = ${s2.df}, p = ${s2.pValue < 0.0001 ? '<0.0001' : round(s2.pValue, 6)}, Cramér's V = ${round(s2.cramersV)}, n = ${s2.n}\n`;
  const s3 = stats.donorAcceptorKmCorrelation;
  md += `- log10(Donor Km) vs log10(Acceptor Km): Pearson r = ${round(s3.r)}, n = ${s3.n}\n`;
  md += `- Missingness: donor Km missing in ${stats.missingness.donorKm}/${stats.missingness.total}, acceptor Km missing in ${stats.missingness.acceptorKm}/${stats.missingness.total}, pH unparseable/out-of-range in ${stats.missingness.ph}/${stats.missingness.total}, temperature in ${stats.missingness.temperature}/${stats.missingness.total}\n\n`;

  md += `## 5. Bivariate analyses\n\n### Plant\n\n`;
  md += bivariateToMarkdown('Family × number of known enzymes', bivar.plant.family_enzymeCount);
  md += bivariateToMarkdown('Family × acceptor class', bivar.plant.family_acceptorClass);
  md += bivariateToMarkdown('Family × donor', bivar.plant.family_donor);
  md += bivariateToMarkdown('Genus × number of known enzymes', bivar.plant.genus_enzymeCount);
  md += bivariateToMarkdown('Genus × acceptor class', bivar.plant.genus_acceptorClass);
  md += bivariateToMarkdown('Genus × donor', bivar.plant.genus_donor);
  md += `### Fungal\n\n`;
  md += bivariateToMarkdown('Family × number of known enzymes', bivar.fungal.family_enzymeCount);
  md += bivariateToMarkdown('Family × acceptor class', bivar.fungal.family_acceptorClass);
  md += bivariateToMarkdown('Family × donor', bivar.fungal.family_donor);
  md += bivariateToMarkdown('Genus × number of known enzymes', bivar.fungal.genus_enzymeCount);
  md += bivariateToMarkdown('Genus × acceptor class', bivar.fungal.genus_acceptorClass);
  md += bivariateToMarkdown('Genus × donor', bivar.fungal.genus_donor);

  md += `## 6. Donor rules, regiospecificity, and the AhPT1 special case\n\n`;
  md += `Regiospecificity is always recorded together with the record's Acceptor class, and is never aggregated across different acceptor classes (e.g. Flavonoid C3 and Coumarin C3 remain distinct categories in every table above).\n\n`;
  md += `AhPT1 (S. No. 55) is represented as a manually curated, cofactor-dependent special case rather than auto-parsed, because its source row packs two experimental conditions into ragged parallel line-lists that cannot be safely auto-aligned across columns:\n\n`;
  const ahpt1 = records.find((r) => r.enzyme === 'AhPT1');
  if (ahpt1?.cofactorConditions) {
    ahpt1.cofactorConditions.forEach((c) => {
      md += `- **${c.metal}** + ${c.acceptorSubstrate} → ${c.outcome}${c.product ? ` (${c.product}${c.regio ? `, ${c.regio}` : ''})` : ''}: ${c.note}\n`;
    });
  }
  md += `\n`;

  md += `## 7. Biological insights (computed observations, not literature claims)\n\n`;
  insights.forEach((i) => { md += `- ${i.text}\n`; });
  md += `\n`;

  md += `## 8. Data-quality issues and manual review\n\n`;
  md += `${state.manualReview.length} record(s)/fields flagged for manual review; ${state.auditLog.length} normalization audit-log entries. See \`manual_review.csv\` and \`audit_log.csv\` alongside this report.\n\n`;

  md += `## 9. References\n\n`;
  const seen = new Set();
  records.forEach((r) => {
    if (!r.doi || seen.has(r.doi)) return;
    seen.add(r.doi);
    md += `- ${r.author || 'Unknown author'} — ${r.enzyme} — ${r.doi}\n`;
  });
  md += `\n`;

  md += `## 10. Reproducibility\n\n`;
  md += `Regenerate this report at any time with \`npm run report\`, or by uploading/editing the source workbook (regeneration is automatic after every successful ingest). Canonical data lives in \`data/canonical/dataset.sqlite\` (table \`records\`, one immutable version per successful ingest); the exact source row for every record is preserved in \`raw_rows\`.\n`;

  return md;
}

function writeCsv(filePath, rows) {
  fs.writeFileSync(filePath, stringify(rows, { header: true }));
}

function generateReport(state, { trigger } = {}) {
  fs.mkdirSync(config.reportsDir, { recursive: true });
  const records = state.records;

  fs.writeFileSync(path.join(config.reportsDir, 'report.md'), buildReportMarkdown(state));
  fs.writeFileSync(path.join(config.reportsDir, 'report_summary.json'), JSON.stringify(buildSummaryJson(state), null, 2));

  writeCsv(path.join(config.reportsDir, 'records_filtered.csv'), records.map((r) => ({
    id: r.id, enzyme: r.enzyme, origin: r.origin, acceptorClass: r.acceptorClass, family: r.family,
    genus: r.genus, species: r.species, expressionHost: r.expressionHost, year: r.year,
    primaryDonor: r.primaryDonor, allAcceptedDonors: r.allAcceptedDonors.join('; '),
    acceptedMetals: r.acceptedMetals.join('; '), ph: r.ph.mid, temperature: r.temp.mid,
    dataCompleteness: r.dataCompleteness, promiscuousDmapp: r.promiscuousDmapp, doi: r.doi,
  })));

  writeCsv(path.join(config.reportsDir, 'manual_review.csv'), state.manualReview.map((m) => ({
    sno: m.sno, enzyme: m.enzyme, sourceRow: m.sourceRow, reason: m.reason,
  })));

  writeCsv(path.join(config.reportsDir, 'audit_log.csv'), state.auditLog.map((a) => ({
    field: a.field, sourceRow: a.sourceRow ?? '', enzyme: a.enzyme ?? '', raw: a.raw ?? a.detail ?? '',
    normalized: a.normalized ?? '', rule: a.rule ?? '',
  })));

  const bivar = allBivariate(records);
  for (const origin of ['plant', 'fungal']) {
    for (const [key, table] of Object.entries(bivar[origin])) {
      const rows = table.dimension === 'enzymeCount'
        ? table.rows.map((r) => ({ group: r.group, count: r.count, percent: round(r.percent, 1) }))
        : table.rows.map((r) => ({ group: r.group, value: r.value, count: r.count, denominator: r.denominator, percent: round(r.percent, 1) }));
      writeCsv(path.join(config.reportsDir, `bivariate_${origin}_${key}.csv`), rows);
    }
  }

  return { trigger, generatedAt: new Date().toISOString(), dir: config.reportsDir };
}

module.exports = { generateReport, buildReportMarkdown, buildSummaryJson };
