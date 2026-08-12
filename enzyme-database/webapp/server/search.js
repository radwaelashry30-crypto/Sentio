'use strict';

// Free, 100%-local smart search over the dataset — keyword retrieval with a
// deterministic (non-AI) summary. No external API, no cost, no API key.

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'in', 'on', 'for', 'to', 'and', 'or',
  'which', 'what', 'how', 'many', 'does', 'do', 'with', 'that', 'this', 'has', 'have', 'any', 'all', 'me', 'about']);

// Common Arabic domain terms mapped to the English tokens actually stored in
// the dataset. The underlying records are all in English (enzyme names,
// families, chemical names), so an Arabic query can only ever match via this
// bridge — it is intentionally small and scoped to terms that appear in this
// dataset, not a general translator.
const ARABIC_TERM_MAP = {
  'فطري': 'fungal', 'فطر': 'fungal', 'فطريات': 'fungal',
  'نباتي': 'plant', 'نبات': 'plant', 'نباتات': 'plant',
  'انزيم': 'enzyme', 'إنزيم': 'enzyme', 'انزيمات': 'enzyme', 'إنزيمات': 'enzyme',
  'حرارة': 'temperature', 'الحرارة': 'temperature', 'درجة': 'temperature',
  'حموضة': 'ph', 'الحموضة': 'ph',
  'معدن': 'metal', 'المعدن': 'metal', 'معادن': 'metal', 'كوفاكتور': 'cofactor',
  'دونور': 'donor', 'مانح': 'donor', 'مانحات': 'donor',
  'مستقبل': 'acceptor', 'مستقبلات': 'acceptor',
  'عائلة': 'family', 'الفصيلة': 'family', 'فصيلة': 'family',
  'جنس': 'genus',
  'سنة': 'year', 'عام': 'year',
  'مؤلف': 'author', 'كاتب': 'author',
  'خميرة': 'yeast',
};

// Matches Latin letters/digits AND Arabic-script letters (Unicode block
// U+0600–U+06FF), so an Arabic query produces real tokens instead of an
// empty list.
const TOKEN_REGEX = /[a-z0-9'+-]+|[؀-ۿ]+/g;

function tokenize(text) {
  const raw = String(text).toLowerCase().match(TOKEN_REGEX) || [];
  return raw.map((t) => ARABIC_TERM_MAP[t] || t);
}

function recordSearchableText(r) {
  return [
    r.enzyme, r.organism, r.family, r.genus, r.species, r.acceptorClass,
    r.primaryDonor, ...(r.allAcceptedDonors || []), ...(r.acceptedMetals || []),
    ...(r.acceptedAcceptors || []), r.expressionHost, r.author, r.doi, r.origin,
    r.year, r.product, r.ph?.valid ? `ph ${r.ph.mid}` : '', r.temp?.valid ? `temperature ${r.temp.mid}` : '',
    ...(r.regioTokens || []),
  ].filter(Boolean).join(' ').toLowerCase();
}

/** Keyword retrieval: score every record by query-term overlap, return the top N.
 *  Returns an empty match list (never a misleading arbitrary fallback) when
 *  the query has real terms but none of them actually appear in any record. */
function retrieveRelevantRecords(question, records, topN = 20) {
  const allTerms = tokenize(question);
  const terms = allTerms.filter((t) => !STOPWORDS.has(t) && t.length > 1);

  if (terms.length === 0) {
    return { matches: [], terms: [], noUsableTerms: true };
  }

  const scored = records.map((r) => {
    const text = recordSearchableText(r);
    let score = 0;
    for (const term of terms) {
      if (text.includes(term)) score += 1;
      if (r.enzyme && r.enzyme.toLowerCase() === term) score += 3;
    }
    return { r, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const withHits = scored.filter((s) => s.score > 0);
  return { matches: withHits.slice(0, topN).map((s) => s.r), terms, noUsableTerms: false };
}

function mostCommon(values) {
  const counts = new Map();
  values.forEach((v) => { if (v) counts.set(v, (counts.get(v) || 0) + 1); });
  let best = null, bestCount = 0;
  for (const [v, c] of counts.entries()) if (c > bestCount) { best = v; bestCount = c; }
  return best ? { value: best, count: bestCount } : null;
}

/** A short, deterministic (rule-based, not AI-generated) summary of the matches. */
function summarize(matches, totalCount, terms, noUsableTerms) {
  if (noUsableTerms) {
    return 'Could not extract any searchable keyword from that query — try a specific enzyme name, family, genus, acceptor class, donor, or metal ion.';
  }
  if (matches.length === 0) {
    return `No records matched "${terms.join(', ')}" in the current filtered set. Try a different spelling or a broader term (e.g. an acceptor class or family name instead of a full sentence).`;
  }
  const plant = matches.filter((r) => r.origin === 'Plant').length;
  const fungal = matches.filter((r) => r.origin === 'Fungal').length;
  const topClass = mostCommon(matches.map((r) => r.acceptorClass));
  const topDonor = mostCommon(matches.flatMap((r) => r.allAcceptedDonors));

  const bits = [`${matches.length} of ${totalCount} records match`];
  bits.push(`${plant} plant, ${fungal} fungal`);
  if (topClass) bits.push(`most common acceptor class: ${topClass.value} (${topClass.count})`);
  if (topDonor) bits.push(`most common donor: ${topDonor.value} (${topDonor.count})`);
  return bits.join(' — ');
}

function searchRecords(question, records, topN = 20) {
  const { matches, terms, noUsableTerms } = retrieveRelevantRecords(question, records, topN);
  return {
    ok: true,
    summary: summarize(matches, records.length, terms, noUsableTerms),
    matchedTerms: terms,
    totalCount: records.length,
    matchCount: matches.length,
    records: matches.map((r) => ({
      id: r.id, enzyme: r.enzyme, origin: r.origin, family: r.family, genus: r.genus,
      acceptorClass: r.acceptorClass, primaryDonor: r.primaryDonor,
      allAcceptedDonors: r.allAcceptedDonors, acceptedMetals: r.acceptedMetals,
      expressionHost: r.expressionHost, year: r.year, author: r.author, doi: r.doi,
    })),
  };
}

module.exports = { searchRecords, retrieveRelevantRecords, tokenize };
