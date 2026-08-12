'use strict';

const {
  DONOR_TOKEN_REGEX,
  METAL_TOKEN_REGEX,
  PROMISCUOUS_NOTE_REGEX,
  PH_MIN,
  PH_MAX,
  TEMP_MIN,
  TEMP_MAX,
  KM_UNIT_TO_UM,
} = require('./constants');

// Standalone-number matcher: rejects digits glued to letters on either side,
// so "1367TH-4PX" and "v1" never yield spurious numeric values, while
// "8" in "8 for formation of 1367TH-4PX with v1" is still captured.
const STANDALONE_NUMBER = /(?<![A-Za-z0-9])(\d+(?:[.,]\d+)?)(?![A-Za-z0-9])/g;

function toNumber(token) {
  // A bare "8,8" pattern is a European decimal (8.8); anything else keeps '.'.
  if (/^\d+,\d+$/.test(token)) return parseFloat(token.replace(',', '.'));
  return parseFloat(token.replace(',', ''));
}

function standaloneNumbers(text) {
  if (!text) return [];
  const out = [];
  let m;
  STANDALONE_NUMBER.lastIndex = 0;
  while ((m = STANDALONE_NUMBER.exec(text)) !== null) out.push(toNumber(m[1]));
  return out;
}

// ---------------------------------------------------------------------------
// Acceptor-class normalization (capitalization + whitespace only)
// ---------------------------------------------------------------------------
function normalizeAcceptorClass(raw, auditLog) {
  if (!raw) return { value: null, wasNormalized: false };
  const trimmed = String(raw).replace(/\s+/g, ' ').trim();
  const canonical = trimmed.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  if (canonical !== trimmed) {
    auditLog.push({
      field: 'Acceptor class',
      raw: raw,
      normalized: canonical,
      rule: 'capitalization/whitespace fold',
    });
  }
  return { value: canonical, wasNormalized: canonical !== raw };
}

// ---------------------------------------------------------------------------
// Genus / species extraction
// ---------------------------------------------------------------------------
function splitOrganism(raw) {
  if (!raw) return { genus: null, species: null, commonName: null, organism: null };
  const text = String(raw).trim();
  const parenMatch = text.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const namePart = parenMatch ? parenMatch[1].trim() : text;
  const commonName = parenMatch ? parenMatch[2].trim() : null;
  const tokens = namePart.split(/\s+/).filter(Boolean);
  const genus = tokens[0] || null;
  let species = null;
  if (tokens[1] && /^[a-z]/.test(tokens[1]) && tokens[1] !== 'sp.' && tokens[1] !== 'sp') {
    species = tokens[1].replace(/[.,]$/, '');
  }
  return { genus, species, commonName, organism: namePart };
}

// ---------------------------------------------------------------------------
// Controlled-vocabulary list explosion (donors / metal ions)
// ---------------------------------------------------------------------------
function canonicalizeToken(line, tokenRegex) {
  if (tokenRegex === METAL_TOKEN_REGEX) {
    return line.replace(/^([A-Za-z]{1,2})(\d*\+{1,3})$/, (m, el, charge) => el[0].toUpperCase() + el.slice(1).toLowerCase() + charge);
  }
  return line.toUpperCase().replace(/^OCTAPRENYL DIPHOSPHATE$/i, 'Octaprenyl diphosphate');
}

function explodeControlledList(raw, tokenRegex, fieldName, sourceRow, auditLog) {
  if (!raw) return { tokens: [], notes: [] };
  const text = String(raw);
  const lines = text.split('\n').flatMap((l) => l.split(','));
  const tokens = [];
  const notes = [];

  lines.forEach((lineRaw) => {
    let line = lineRaw.trim();
    if (!line) return;
    const original = line;
    line = line.replace(/^\d+[.)]\s*/, ''); // strip leading list numbering
    let concentration = null;
    const concMatch = line.match(/^(\d+(?:\.\d+)?)\s*(m|µ|u|n)?M\s+(.*)$/i);
    if (concMatch) {
      concentration = `${concMatch[1]} ${concMatch[2] || ''}M`.trim();
      line = concMatch[3].trim();
    }
    const percentMatch = line.match(/^(.*?)\s*\((\d+(?:\.\d+)?)\s*%\)\s*$/);
    let percent = null;
    if (percentMatch) {
      line = percentMatch[1].trim();
      percent = parseFloat(percentMatch[2]);
    }
    const starMatch = line.match(/^(.*?)\s*\*+\s*$/);
    let footnoted = false;
    if (starMatch && tokenRegex.test(starMatch[1].trim())) {
      line = starMatch[1].trim();
      footnoted = true;
    }
    if (line.startsWith('**') || /^when\b/i.test(line) || line.length > 40) {
      // Free-text footnote / explanatory sentence, not a substrate token.
      notes.push(line);
      return;
    }
    if (tokenRegex.test(line)) {
      tokens.push({ value: canonicalizeToken(line, tokenRegex), percent, footnoted, concentration });
      if (concentration && auditLog) {
        auditLog.push({
          field: fieldName, sourceRow, raw: original, normalized: canonicalizeToken(line, tokenRegex),
          rule: `leading concentration prefix "${concentration}" stripped and retained as metadata`,
        });
      }
      return;
    }
    // Trailing free-text after a valid leading token, e.g. "Mn2+ (62% of Mg2+)".
    const leadingMatch = line.match(/^(\S+)\s*(\(.*\))?\s*$/);
    if (leadingMatch && tokenRegex.test(leadingMatch[1])) {
      tokens.push({ value: canonicalizeToken(leadingMatch[1], tokenRegex), percent, footnoted, concentration });
      if (auditLog && leadingMatch[2]) {
        auditLog.push({
          field: fieldName, sourceRow, raw: original, normalized: canonicalizeToken(leadingMatch[1], tokenRegex),
          rule: `trailing annotation "${leadingMatch[2]}" retained as note, not parsed as a separate substrate`,
        });
      }
      return;
    }
    if (line) {
      notes.push(line);
      if (auditLog) {
        auditLog.push({
          field: fieldName,
          sourceRow,
          raw: line,
          rule: 'unrecognized token retained as free-text note (not counted as a substrate)',
        });
      }
    }
  });

  return { tokens, notes };
}

// ---------------------------------------------------------------------------
// Free-text list explosion (aromatic acceptor substrate names — newline only,
// since chemical names legitimately contain commas)
// ---------------------------------------------------------------------------
function explodeFreeTextList(raw) {
  if (!raw) return [];
  return String(raw)
    .split('\n')
    .map((l) => l.replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Regio-position canonicalization. Extracts a short "C3" / "O5" style label
// from each free-text regio token so records can be filtered/grouped by
// position — while the raw tokens (and their tie to this record's own
// acceptorClass) are always kept alongside, so a position is never presented
// without its acceptor-class context and never merged across classes.
// ---------------------------------------------------------------------------
const REGIO_POSITION_REGEX = /^([CO])[\s-]?(\d+)?/i;

function canonicalizeRegioPositions(regioTokens) {
  const positions = [];
  for (const token of regioTokens) {
    const trimmed = token.trim();
    if (/^(n\.?a\.?|no precise annotation)$/i.test(trimmed)) continue;
    const m = trimmed.match(REGIO_POSITION_REGEX);
    if (m) {
      const canonical = m[1].toUpperCase() + (m[2] || '');
      if (!positions.includes(canonical)) positions.push(canonical);
    } else if (!positions.includes('Other')) {
      positions.push('Other');
    }
  }
  return positions;
}

// ---------------------------------------------------------------------------
// pH / temperature parsing with plausibility-based swap correction
// ---------------------------------------------------------------------------
function parseRangeField(raw, { min, max }) {
  if (!raw) return { low: null, high: null, mid: null, raw: raw || null, valid: null, note: null };
  const text = String(raw).trim();
  const rangeMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(?:to|-|–|—)\s*(\d+(?:[.,]\d+)?)/);
  let low = null;
  let high = null;
  let note = null;

  if (rangeMatch && !/[A-Za-z]/.test(text.slice(rangeMatch.index, rangeMatch.index + rangeMatch[0].length + 3).replace(rangeMatch[0], ''))) {
    low = toNumber(rangeMatch[1]);
    high = toNumber(rangeMatch[2]);
  } else {
    const nums = standaloneNumbers(text);
    if (nums.length === 1) {
      low = high = nums[0];
    } else if (nums.length > 1) {
      low = high = nums[0];
      note = `Multiple numeric tokens found in "${text}"; used first (${nums[0]}) and flagged for manual review.`;
    }
  }

  if (low == null) {
    return { low: null, high: null, mid: null, raw: text, valid: false, note: `No parseable numeric value in "${text}".` };
  }

  const mid = (low + high) / 2;
  const valid = low >= min && low <= max && high >= min && high <= max;
  return { low, high, mid, raw: text, valid, note };
}

function parsePhAndTemp(phRaw, tempRaw) {
  const auditNotes = [];
  let ph = parseRangeField(phRaw, { min: PH_MIN, max: PH_MAX });
  let temp = parseRangeField(tempRaw, { min: TEMP_MIN, max: TEMP_MAX });
  let swapped = false;

  const phOutOfRange = phRaw && ph.low != null && (ph.low > PH_MAX || ph.high > PH_MAX);
  const tempLooksLikePh =
    tempRaw && temp.low != null && temp.low <= PH_MAX && temp.high <= PH_MAX;
  const phLooksLikeTemp =
    phRaw && ph.low != null && ph.low <= TEMP_MAX && ph.high <= TEMP_MAX;

  if (phOutOfRange && tempLooksLikePh && phLooksLikeTemp) {
    const newPh = parseRangeField(tempRaw, { min: PH_MIN, max: PH_MAX });
    const newTemp = parseRangeField(phRaw, { min: TEMP_MIN, max: TEMP_MAX });
    auditNotes.push({
      rule: 'pH/temperature plausibility swap',
      detail: `Raw pH "${phRaw}" is outside 0–14; raw temperature "${tempRaw}" is a plausible pH. Columns swapped back: pH ← "${tempRaw}", temperature ← "${phRaw}".`,
    });
    ph = newPh;
    temp = newTemp;
    swapped = true;
  }

  return { ph, temp, swapped, auditNotes };
}

// ---------------------------------------------------------------------------
// Km value parsing: "Label: number unit" per line
// ---------------------------------------------------------------------------
const KM_LINE_REGEX = /^(.*?):\s*([\d.]+)\s*(nM|µM|μM|uM|mM|M)\b/i;

function parseKmField(raw, acceptedDonorTokens) {
  if (!raw) return [];
  const donorNames = new Set(acceptedDonorTokens.map((t) => t.value.toUpperCase()));
  const lines = String(raw).split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  lines.forEach((line) => {
    const m = line.match(KM_LINE_REGEX);
    if (!m) return;
    const label = m[1].trim();
    const value = parseFloat(m[2]);
    let unitKey = m[3].toLowerCase();
    if (unitKey === 'um' || unitKey === 'μm') unitKey = 'µm';
    const factor = KM_UNIT_TO_UM[unitKey] ?? KM_UNIT_TO_UM[m[3]] ?? null;
    if (factor == null || Number.isNaN(value)) return;
    const isDonor = DONOR_TOKEN_REGEX.test(label) || donorNames.has(label.toUpperCase());
    out.push({
      label,
      rawValue: value,
      rawUnit: m[3],
      valueUM: value * factor,
      role: isDonor ? 'donor' : 'acceptor',
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// AhPT1 (S. No. 55) hardcoded cofactor-dependent special case. The source
// spreadsheet packs two distinct experimental conditions into one row using
// ragged parallel line-lists that cannot be safely auto-aligned across
// columns. Per the master prompt this is treated as a documented, manually
// curated override rather than an auto-parsed entry.
// ---------------------------------------------------------------------------
function ahpt1CofactorConditions(enzymeName) {
  if (enzymeName !== 'AhPT1') return null;
  return [
    {
      metal: 'Mg2+',
      acceptorSubstrate: 'Genistein',
      regio: 'C6',
      product: '6-prenylgenistein',
      outcome: 'active',
      note: 'Mg2+ supports 6-C-prenylation of genistein.',
    },
    {
      metal: 'Mn2+',
      acceptorSubstrate: "6-hydroxyflavone",
      regio: 'C5',
      product: '5-C-prenylated 6-hydroxyflavone',
      outcome: 'active-high-conversion',
      note: 'Mn2+ produces 5-C-prenylated 6-hydroxyflavone with high conversion.',
    },
    {
      metal: 'Mg2+',
      acceptorSubstrate: "6-hydroxyflavone",
      regio: null,
      product: null,
      outcome: 'undetectable',
      note: 'Activity toward 6-hydroxyflavone with Mg2+ was undetectable.',
    },
  ];
}

const PROMISCUITY_ACCEPTOR_THRESHOLD = 4;

function normalizeRow(row) {
  const auditLog = [];
  const manualReview = [];
  const sourceRow = row.__sourceRow;
  const sno = row['S. No.'];
  const enzymeRaw = row['Enzyme'] ? String(row['Enzyme']).trim() : null;
  const enzymeLines = enzymeRaw ? enzymeRaw.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const enzyme = enzymeLines[0] || null;
  const enzymeNote = enzymeLines.length > 1 ? enzymeLines.slice(1).join('; ') : null;
  if (enzymeNote) {
    manualReview.push({ sno, enzyme, sourceRow, reason: `Enzyme cell contains extra variant text beyond the primary name: "${enzymeNote}"` });
  }

  const originRaw = (row['Origin'] || '').toString().trim().toUpperCase();
  const origin = originRaw === 'P' ? 'Plant' : originRaw === 'F' ? 'Fungal' : null;
  if (!origin) manualReview.push({ sno, enzyme, sourceRow, reason: `Unrecognized Origin value "${row['Origin']}"` });

  const acceptorClass = normalizeAcceptorClass(row['Acceptor class'], auditLog);
  const family = row['Family'] ? String(row['Family']).trim() : null;
  const { genus, species, commonName, organism } = splitOrganism(row['Gene from organism']);

  const acceptedAcceptors = explodeFreeTextList(row['Prenyl acceptor (Aromatic substrate) - Accepted']);
  const mediumAcceptors = explodeFreeTextList(row['Prenyl acceptor (Aromatic substrate) - Medium to Not Accepted']);

  const acceptedDonors = explodeControlledList(
    row['Prenyl donor - Accepted'], DONOR_TOKEN_REGEX, 'Prenyl donor - Accepted', sourceRow, auditLog
  );
  const mediumDonors = explodeControlledList(
    row['Prenyl donor - Medium to Not Accepted'], DONOR_TOKEN_REGEX, 'Prenyl donor - Medium to Not Accepted', sourceRow, auditLog
  );
  const acceptedMetals = explodeControlledList(
    row['Metal ion - Accepted'], METAL_TOKEN_REGEX, 'Metal ion - Accepted', sourceRow, auditLog
  );
  const mediumMetals = explodeControlledList(
    row['Metal ion - Medium to Not Accepted'], METAL_TOKEN_REGEX, 'Metal ion - Medium to Not Accepted', sourceRow, auditLog
  );

  const primaryDonor = acceptedDonors.tokens[0]?.value || null;
  const allAcceptedDonors = acceptedDonors.tokens.map((t) => t.value);

  const { ph, temp, swapped, auditNotes } = parsePhAndTemp(row['Optimal pH'], row['Optimal temperature']);
  auditNotes.forEach((n) => auditLog.push({ field: 'Optimal pH / Optimal temperature', sourceRow, enzyme, ...n }));
  if (swapped) manualReview.push({ sno, enzyme, sourceRow, reason: 'pH/temperature columns auto-swapped (plausibility correction) — verify against source publication.' });

  const kmEntries = parseKmField(row['Km value'], acceptedDonors.tokens);

  const regioTokens = explodeFreeTextList(row['Regio specificity']);
  const regioPositions = canonicalizeRegioPositions(regioTokens);

  const allNotes = [...acceptedDonors.notes, ...mediumDonors.notes];
  const promiscuousDmapp =
    allAcceptedDonors.includes('DMAPP') &&
    (acceptedAcceptors.length >= PROMISCUITY_ACCEPTOR_THRESHOLD ||
      allNotes.some((n) => PROMISCUOUS_NOTE_REGEX.test(n)));
  if (promiscuousDmapp) {
    manualReview.push({
      sno,
      enzyme,
      sourceRow,
      reason: `Flagged as promiscuous DMAPP acceptor (heuristic: DMAPP accepted + ${acceptedAcceptors.length} accepted aromatic substrates, threshold ${PROMISCUITY_ACCEPTOR_THRESHOLD}). Confirm against source publication.`,
    });
  }

  const cofactorConditions = ahpt1CofactorConditions(enzyme);
  if (cofactorConditions) {
    manualReview.push({
      sno,
      enzyme,
      sourceRow,
      reason: 'AhPT1 cofactor-dependent activity (Mg2+ vs Mn2+) represented via a manually curated override — the source row packs both conditions into ragged parallel line-lists that cannot be auto-aligned. Verify against Yang et al. 2020.',
    });
  }

  if (kmEntries.length === 0 && row['Km value']) {
    // Free text present but nothing numerically extractable — expected for
    // most qualitative records; not flagged individually (see report summary).
  }

  const record = {
    id: sno,
    sourceRow,
    enzyme,
    enzymeNote,
    origin,
    originRaw: row['Origin'],
    acceptorClass: acceptorClass.value,
    acceptorClassRaw: row['Acceptor class'],
    family,
    organism,
    organismRaw: row['Gene from organism'],
    genus,
    species,
    commonName,
    expressionHost: row['Expression in'] ? String(row['Expression in']).trim() : null,
    product: row['Product'] || null,
    regioRaw: row['Regio specificity'] || null,
    regioTokens,
    regioPositions,
    year: row['Year'] != null ? Number(row['Year']) : null,
    author: row['Author'] || null,
    doi: row['doi'] || null,
    primaryDonor,
    allAcceptedDonors,
    mediumDonors: mediumDonors.tokens.map((t) => t.value),
    acceptedMetals: acceptedMetals.tokens.map((t) => t.value),
    mediumMetals: mediumMetals.tokens.map((t) => t.value),
    acceptedAcceptors,
    mediumAcceptors,
    kmEntries,
    ph,
    temp,
    phTempSwapped: swapped,
    promiscuousDmapp,
    cofactorConditions,
    dataCompleteness: computeCompleteness({ ph, temp, kmEntries, acceptedDonors: allAcceptedDonors, acceptedMetals: acceptedMetals.tokens }),
  };

  return { record, auditLog, manualReview };
}

function computeCompleteness(r) {
  let score = 0;
  let total = 4;
  if (r.ph.valid) score++;
  if (r.temp.valid) score++;
  if (r.kmEntries.length > 0) score++;
  if (r.acceptedDonors.length > 0) score++;
  if (score === total) return 'complete';
  if (score === 0) return 'minimal';
  return 'partial';
}

function normalizeDataset(rows) {
  const records = [];
  const auditLog = [];
  const manualReview = [];
  for (const row of rows) {
    const { record, auditLog: rowAudit, manualReview: rowReview } = normalizeRow(row);
    records.push(record);
    auditLog.push(...rowAudit);
    manualReview.push(...rowReview);
  }

  const knownSno = new Set(records.map((r) => r.id));
  [186, 187].forEach((n) => {
    if (!knownSno.has(n)) {
      manualReview.push({
        sno: n,
        enzyme: null,
        sourceRow: null,
        reason: `Referenced in the prior master prompt's special donor-rule list but no S. No. ${n} exists in the current ${records.length}-record workbook — likely a stale reference from an earlier dataset revision.`,
      });
    }
  });

  return { records, auditLog, manualReview };
}

module.exports = {
  normalizeDataset,
  normalizeRow,
  normalizeAcceptorClass,
  splitOrganism,
  explodeControlledList,
  explodeFreeTextList,
  parsePhAndTemp,
  parseRangeField,
  parseKmField,
  standaloneNumbers,
  canonicalizeRegioPositions,
};
