'use strict';

// Free, 100%-local smart search over the dataset — keyword retrieval with a
// deterministic (non-AI) summary. No external API, no cost, no API key.

// General English function/grammar words, plus domain-generic nouns that
// carry zero discriminating power here because every single record is an
// "enzyme" record (so the literal words "enzyme"/"accept"/"source" etc.
// never usefully narrow anything, unlike a specific compound or family
// name). Deliberately broad: a natural-language question ("enzymes that
// accept X from Y sources") is mostly filler words around the 1-2 terms
// that actually matter, and any filler word left in gets IDF-weighted
// below -- if it happens to occur rarely in the free-text notes by
// coincidence (as "from" originally did), it would be wrongly treated as
// highly specific/important instead of being dropped as noise.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'in', 'on', 'for', 'to', 'from', 'by', 'at', 'as', 'into', 'onto', 'upon', 'via',
  'over', 'under', 'between', 'among', 'across', 'after', 'before', 'during', 'since', 'until', 'without', 'within',
  'and', 'or', 'nor', 'but', 'if', 'because', 'so', 'than', 'then', 'also',
  'which', 'what', 'how', 'many', 'much', 'does', 'do', 'did', 'done', 'can', 'could', 'would', 'will', 'shall', 'should', 'may', 'might', 'must',
  'with', 'that', 'this', 'these', 'those', 'there', 'here',
  'has', 'have', 'had', 'any', 'all', 'both', 'each', 'every', 'either', 'neither', 'other', 'some', 'such', 'no', 'not',
  'me', 'my', 'i', 'we', 'our', 'you', 'your', 'it', 'its', 'they', 'them', 'their', 'he', 'she', 'his', 'her', 'him',
  'more', 'most', 'less', 'least', 'very', 'just', 'only', 'same', 'own', 'again', 'once', 'out', 'up', 'down', 'off', 'above', 'below',
  'about', 'please', 'tell', 'show', 'list', 'find', 'give', 'get', 'know', 'let', 'want', 'need', 'looking', 'look',
  'enzyme', 'enzymes', 'accept', 'accepts', 'accepted', 'accepting', 'source', 'sources',
  'record', 'records', 'data', 'information', 'characterized', 'known', 'available', 'type', 'types',
]);

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
 *  the query has real terms but none of them actually appear in any record.
 *  `matchCount` is the TRUE number of records that matched, before topN
 *  truncation -- callers must use that for "N of M match" reporting, not
 *  matches.length, or a truncated result silently undercounts itself.
 *
 *  Terms are matched as whole words (via each record's own tokenized text,
 *  not a raw substring check -- so a short term like "ion" can't spuriously
 *  match inside an unrelated word like "prenylation"), and weighted by
 *  rarity (IDF-style: log(N / docFreq)) rather than counted equally. Without
 *  that weighting, a multi-word natural-language question -- e.g. "enzymes
 *  that accept orsellinic acid from fungal sources" -- would count a record
 *  as a "match" for sharing just the single common word "fungal" (present in
 *  roughly a quarter of the whole dataset) even if it has nothing to do with
 *  orsellinic acid; a record only clears the relevance threshold below by
 *  actually sharing enough of the query's more specific/rare terms. */
function retrieveRelevantRecords(question, records, topN = 200) {
  const allTerms = tokenize(question);
  const terms = [...new Set(allTerms.filter((t) => !STOPWORDS.has(t) && t.length > 1))];

  if (terms.length === 0) {
    return { matches: [], matchCount: 0, terms: [], noUsableTerms: true };
  }

  const recordWordSets = records.map((r) => new Set(tokenize(recordSearchableText(r))));
  const docFreq = new Map();
  for (const term of terms) {
    docFreq.set(term, recordWordSets.reduce((n, words) => n + (words.has(term) ? 1 : 0), 0));
  }
  // A term that occurs in zero records can never usefully narrow anything --
  // dropped instead of being treated as an impossible-to-hit part of the
  // theoretical maximum score, which would make the relevance threshold
  // below unreachably strict.
  const usableTerms = terms.filter((t) => docFreq.get(t) > 0);
  if (usableTerms.length === 0) {
    return { matches: [], matchCount: 0, terms, noUsableTerms: false };
  }

  const weight = new Map(usableTerms.map((t) => [t, Math.log((records.length + 1) / (docFreq.get(t) + 1)) + 0.1]));
  const maxScore = usableTerms.reduce((sum, t) => sum + weight.get(t), 0);
  const relevanceThreshold = maxScore * 0.3;

  const scored = records.map((r, i) => {
    let score = 0;
    for (const term of usableTerms) if (recordWordSets[i].has(term)) score += weight.get(term);
    if (r.enzyme && usableTerms.includes(r.enzyme.toLowerCase())) score += 3;
    return { r, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const withHits = scored.filter((s) => s.score >= relevanceThreshold);
  return { matches: withHits.slice(0, topN).map((s) => s.r), matchCount: withHits.length, terms, noUsableTerms: false };
}

function mostCommon(values) {
  const counts = new Map();
  values.forEach((v) => { if (v) counts.set(v, (counts.get(v) || 0) + 1); });
  let best = null, bestCount = 0;
  for (const [v, c] of counts.entries()) if (c > bestCount) { best = v; bestCount = c; }
  return best ? { value: best, count: bestCount } : null;
}

/** A short, deterministic (rule-based, not AI-generated) summary of the matches.
 *  `matchCount` is the true total (pre-truncation); `matches` is what's actually
 *  being returned/rendered, which may be fewer if it was capped by topN. */
function summarize(matches, matchCount, totalCount, terms, noUsableTerms) {
  if (noUsableTerms) {
    return 'Could not extract any searchable keyword from that query — try a specific enzyme name, family, genus, acceptor class, donor, or metal ion.';
  }
  if (matchCount === 0) {
    return `No records matched "${terms.join(', ')}" in the current filtered set. Try a different spelling or a broader term (e.g. an acceptor class or family name instead of a full sentence).`;
  }
  const plant = matches.filter((r) => r.origin === 'Plant').length;
  const fungal = matches.filter((r) => r.origin === 'Fungal').length;
  const topClass = mostCommon(matches.map((r) => r.acceptorClass));
  const topDonor = mostCommon(matches.flatMap((r) => r.allAcceptedDonors));

  const bits = [`${matchCount} of ${totalCount} records match`];
  if (matches.length < matchCount) bits[0] += ` (showing top ${matches.length})`;
  bits.push(`${plant} plant, ${fungal} fungal`);
  if (topClass) bits.push(`most common acceptor class: ${topClass.value} (${topClass.count})`);
  if (topDonor) bits.push(`most common donor: ${topDonor.value} (${topDonor.count})`);
  return bits.join(' — ');
}

function searchRecords(question, records, topN = 200) {
  const { matches, matchCount, terms, noUsableTerms } = retrieveRelevantRecords(question, records, topN);
  return {
    ok: true,
    summary: summarize(matches, matchCount, records.length, terms, noUsableTerms),
    matchedTerms: terms,
    totalCount: records.length,
    matchCount,
    records: matches.map((r) => ({
      id: r.id, enzyme: r.enzyme, origin: r.origin, family: r.family, genus: r.genus,
      acceptorClass: r.acceptorClass, primaryDonor: r.primaryDonor,
      allAcceptedDonors: r.allAcceptedDonors, acceptedMetals: r.acceptedMetals,
      expressionHost: r.expressionHost, year: r.year, author: r.author, doi: r.doi,
    })),
  };
}

module.exports = { searchRecords, retrieveRelevantRecords, tokenize };
