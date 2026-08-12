'use strict';

// Canonical column names expected in the source workbook/CSV (order-independent,
// matched case-insensitively with whitespace trimmed). Trailing unnamed/blank
// columns in the source file are ignored automatically by parseWorkbook.js.
const REQUIRED_COLUMNS = [
  'S. No.',
  'Enzyme',
  'Acceptor class',
  'Family',
  'Origin',
  'Gene from organism',
  'Prenyl acceptor (Aromatic substrate) - Accepted',
  'Prenyl acceptor (Aromatic substrate) - Medium to Not Accepted',
  'Prenyl donor - Accepted',
  'Prenyl donor - Medium to Not Accepted',
  'Metal ion - Accepted',
  'Metal ion - Medium to Not Accepted',
  'Expression in',
  'Product',
  'Regio specificity',
  'Km value',
  'Optimal pH',
  'Optimal temperature',
  'Year',
  'Author',
  'doi',
];

// Fixed vocabulary of prenyl-donor codes. Used to decide whether a comma inside
// a donor cell separates distinct substrates (as opposed to being punctuation
// inside a free-text note, e.g. "GPP, this enzyme has a broad specificity").
const DONOR_TOKENS = [
  'DMAPP', 'GPP', 'FPP', 'GGPP', 'IPP', 'LPP', 'NPP', 'PPP', 'SPP', 'PDP',
  'OCTAPRENYL DIPHOSPHATE', 'DECAPRENYL DIPHOSPHATE',
];

const DONOR_TOKEN_REGEX = new RegExp(
  '^(' + DONOR_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$',
  'i'
);

// Metal ion / cofactor token shape, e.g. Mg2+, Fe3+, K+, Al3+.
const METAL_TOKEN_REGEX = /^[A-Za-z]{1,2}\d?\+{1,3}$/;

const PROMISCUOUS_NOTE_REGEX = /broad specificity|promiscuous/i;

const PH_MIN = 0;
const PH_MAX = 14;
const TEMP_MIN = 0;
const TEMP_MAX = 100;

const KM_UNIT_TO_UM = {
  nm: 0.001,
  'nM': 0.001,
  um: 1,
  'µm': 1,
  'μm': 1,
  mm: 1000,
  m: 1000000,
};

module.exports = {
  REQUIRED_COLUMNS,
  DONOR_TOKENS,
  DONOR_TOKEN_REGEX,
  METAL_TOKEN_REGEX,
  PROMISCUOUS_NOTE_REGEX,
  PH_MIN,
  PH_MAX,
  TEMP_MIN,
  TEMP_MAX,
  KM_UNIT_TO_UM,
};
