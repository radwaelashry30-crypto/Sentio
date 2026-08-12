'use strict';
/*
 * Enzyme Database — single-page, no-backend dashboard for plant/fungal
 * prenyltransferase enzyme records. Everything below runs client-side only:
 * parsing/writing Excel via the bundled SheetJS build, and persistence via
 * localStorage. No network calls.
 */

// ---------------------------------------------------------------------------
// Schema (matches the source workbook's column headers exactly)
// ---------------------------------------------------------------------------
const REQUIRED_COLUMNS = [
  'S. No.', 'Enzyme', 'Acceptor class', 'Family', 'Origin', 'Gene from organism',
  'Prenyl acceptor (Aromatic substrate) - Accepted',
  'Prenyl acceptor (Aromatic substrate) - Medium to Not Accepted',
  'Prenyl donor - Accepted', 'Prenyl donor - Medium to Not Accepted',
  'Metal ion - Accepted', 'Metal ion - Medium to Not Accepted',
  'Expression in', 'Product', 'Regio specificity', 'Km value',
  'Optimal pH', 'Optimal temperature', 'Year', 'Author', 'doi',
];

const DONOR_TOKENS = ['DMAPP', 'GPP', 'FPP', 'GGPP', 'IPP', 'LPP', 'NPP', 'PPP', 'SPP', 'PDP',
  'OCTAPRENYL DIPHOSPHATE', 'DECAPRENYL DIPHOSPHATE'];
const DONOR_TOKEN_REGEX = new RegExp('^(' + DONOR_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$', 'i');
const METAL_TOKEN_REGEX = /^[A-Za-z]{1,2}\d?\+{1,3}$/;

const FORM_FIELD_TO_COLUMN = {
  enzyme: 'Enzyme', acceptorClass: 'Acceptor class', family: 'Family', origin: 'Origin',
  organism: 'Gene from organism',
  acceptorAccepted: 'Prenyl acceptor (Aromatic substrate) - Accepted',
  acceptorMedium: 'Prenyl acceptor (Aromatic substrate) - Medium to Not Accepted',
  donorAccepted: 'Prenyl donor - Accepted', donorMedium: 'Prenyl donor - Medium to Not Accepted',
  metalAccepted: 'Metal ion - Accepted', metalMedium: 'Metal ion - Medium to Not Accepted',
  expressionHost: 'Expression in', product: 'Product', regio: 'Regio specificity', km: 'Km value',
  ph: 'Optimal pH', temperature: 'Optimal temperature', year: 'Year', author: 'Author', doi: 'doi',
};

const STORAGE_KEY = 'enzymeDb.rows.v1';

// ---------------------------------------------------------------------------
// Normalization helpers (ported from the earlier PT-dashboard's server-side
// pipeline, simplified for a client-only build)
// ---------------------------------------------------------------------------
function normalizeAcceptorClass(raw) {
  if (!raw) return null;
  const trimmed = String(raw).replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

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

function explodeFreeTextList(raw) {
  if (!raw) return [];
  return String(raw).split('\n').map((l) => l.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
}

function explodeControlledList(raw, tokenRegex) {
  if (!raw) return [];
  const lines = String(raw).split('\n').flatMap((l) => l.split(','));
  const tokens = [];
  lines.forEach((lineRaw) => {
    let line = lineRaw.trim();
    if (!line) return;
    line = line.replace(/^\d+[.)]\s*/, '');
    const concMatch = line.match(/^(\d+(?:\.\d+)?)\s*(m|µ|u|n)?M\s+(.*)$/i);
    if (concMatch) line = concMatch[3].trim();
    const percentMatch = line.match(/^(.*?)\s*\((\d+(?:\.\d+)?)\s*%\)\s*$/);
    if (percentMatch) line = percentMatch[1].trim();
    const starMatch = line.match(/^(.*?)\s*\*+\s*$/);
    if (starMatch && tokenRegex.test(starMatch[1].trim())) line = starMatch[1].trim();
    if (line.startsWith('**') || /^when\b/i.test(line) || line.length > 40) return;
    if (tokenRegex.test(line)) {
      tokens.push(tokenRegex === METAL_TOKEN_REGEX
        ? line.replace(/^([A-Za-z]{1,2})(\d*\+{1,3})$/, (m, el, ch) => el[0].toUpperCase() + el.slice(1).toLowerCase() + ch)
        : line.toUpperCase().replace(/^OCTAPRENYL DIPHOSPHATE$/i, 'Octaprenyl diphosphate'));
      return;
    }
    const leadingMatch = line.match(/^(\S+)\s*(\(.*\))?\s*$/);
    if (leadingMatch && tokenRegex.test(leadingMatch[1])) {
      tokens.push(tokenRegex === METAL_TOKEN_REGEX
        ? leadingMatch[1].replace(/^([A-Za-z]{1,2})(\d*\+{1,3})$/, (m, el, ch) => el[0].toUpperCase() + el.slice(1).toLowerCase() + ch)
        : leadingMatch[1].toUpperCase());
    }
  });
  return tokens;
}

function normalizeRawRow(row, index) {
  const sno = row['S. No.'] != null ? row['S. No.'] : index + 1;
  const enzymeRaw = row['Enzyme'] ? String(row['Enzyme']).trim() : null;
  const enzymeLines = enzymeRaw ? enzymeRaw.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const enzyme = enzymeLines[0] || null;
  const originRaw = (row['Origin'] || '').toString().trim().toUpperCase();
  const origin = originRaw === 'P' ? 'Plant' : originRaw === 'F' ? 'Fungal' : null;
  const acceptorClass = normalizeAcceptorClass(row['Acceptor class']);
  const family = row['Family'] ? String(row['Family']).trim() : null;
  const { genus, species, commonName, organism } = splitOrganism(row['Gene from organism']);
  const acceptedAcceptors = explodeFreeTextList(row['Prenyl acceptor (Aromatic substrate) - Accepted']);
  const mediumAcceptors = explodeFreeTextList(row['Prenyl acceptor (Aromatic substrate) - Medium to Not Accepted']);
  const acceptedDonors = explodeControlledList(row['Prenyl donor - Accepted'], DONOR_TOKEN_REGEX);
  const mediumDonors = explodeControlledList(row['Prenyl donor - Medium to Not Accepted'], DONOR_TOKEN_REGEX);
  const acceptedMetals = explodeControlledList(row['Metal ion - Accepted'], METAL_TOKEN_REGEX);
  const mediumMetals = explodeControlledList(row['Metal ion - Medium to Not Accepted'], METAL_TOKEN_REGEX);

  return {
    id: sno, sourceIndex: index, enzyme, origin, originRaw: row['Origin'],
    acceptorClass, acceptorClassRaw: row['Acceptor class'], family,
    organism, organismRaw: row['Gene from organism'], genus, species, commonName,
    expressionHost: row['Expression in'] ? String(row['Expression in']).trim() : null,
    product: row['Product'] || null, regioRaw: row['Regio specificity'] || null,
    year: row['Year'] != null && row['Year'] !== '' ? Number(row['Year']) : null,
    author: row['Author'] || null, doi: row['doi'] || null,
    acceptedDonors, mediumDonors, acceptedMetals, mediumMetals,
    acceptedAcceptors, mediumAcceptors,
    kmRaw: row['Km value'] || null, phRaw: row['Optimal pH'] || null, tempRaw: row['Optimal temperature'] || null,
  };
}

// Levenshtein edit distance (typo-detection helper). O(n*m), fine at this dataset size.
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

// Flags pairs of distinct, non-identical strings that are close enough in
// edit distance to plausibly be a typo of each other rather than a genuinely
// different name. Distance threshold scales gently with string length.
function findSimilarPairs(values) {
  const distinct = [...new Set(values.filter(Boolean).map((v) => String(v).trim()).filter(Boolean))];
  const pairs = [];
  for (let i = 0; i < distinct.length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      const a = distinct[i], b = distinct[j];
      if (a.toLowerCase() === b.toLowerCase()) continue; // exact case-fold match, not a typo
      const maxLen = Math.max(a.length, b.length);
      if (maxLen < 4) continue; // too short to judge reliably
      const dist = levenshtein(a.toLowerCase(), b.toLowerCase());
      const threshold = maxLen <= 8 ? 1 : maxLen <= 16 ? 2 : 3;
      if (dist > 0 && dist <= threshold) pairs.push({ a, b, dist });
    }
  }
  pairs.sort((x, y) => x.dist - y.dist);
  return pairs;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  rawRows: [],       // raw column-keyed objects — the source of truth (persisted)
  records: [],        // normalized, derived from rawRows
  filters: { kingdom: 'All', family: new Set(), genus: new Set(), acceptorClass: new Set(), donor: new Set(), metal: new Set(), search: '' },
};

function rebuildRecords() {
  state.records = state.rawRows.map((r, i) => normalizeRawRow(r, i));
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.rawRows)); } catch (e) { /* storage full/unavailable — non-fatal */ }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { state.rawRows = JSON.parse(raw); return true; }
  } catch (e) { /* ignore corrupt storage */ }
  return false;
}

function loadEmbeddedDefault() {
  const el = document.getElementById('embedded-dataset');
  if (!el) return false;
  try {
    const data = JSON.parse(el.textContent);
    if (Array.isArray(data) && data.length) { state.rawRows = data; return true; }
  } catch (e) { /* ignore */ }
  return false;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------
function applyFilters(records) {
  const f = state.filters;
  const search = f.search.trim().toLowerCase();
  return records.filter((r) => {
    if (f.kingdom !== 'All' && r.origin !== f.kingdom) return false;
    if (f.family.size && !f.family.has(r.family)) return false;
    if (f.genus.size && !f.genus.has(r.genus)) return false;
    if (f.acceptorClass.size && !f.acceptorClass.has(r.acceptorClass)) return false;
    if (f.donor.size && !r.acceptedDonors.some((d) => f.donor.has(d))) return false;
    if (f.metal.size && !r.acceptedMetals.some((m) => f.metal.has(m))) return false;
    if (search) {
      const hay = [r.enzyme, r.organism, r.family, r.genus, r.acceptorClass, r.author, r.doi,
        ...(r.acceptedAcceptors || []), ...(r.acceptedDonors || [])].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

function currentFiltered() { return applyFilters(state.records); }

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v; else if (k === 'html') node.innerHTML = v; else node.setAttribute(k, v);
  }
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function countBy(records, keyFn) {
  const map = new Map();
  records.forEach((r) => {
    const key = keyFn(r);
    if (key == null || key === '') return;
    map.set(key, (map.get(key) || 0) + 1);
  });
  return map;
}

function renderBarList(container, entries, opts) {
  container.innerHTML = '';
  const max = entries.length ? Math.max(...entries.map((e) => e[1])) : 1;
  entries.forEach(([label, count]) => {
    const row = el('div', { class: 'bar-row' + (opts && opts.cls ? ' ' + opts.cls : '') });
    row.appendChild(el('div', { class: 'lbl', title: label, text: label }));
    const track = el('div', { class: 'track' });
    track.appendChild(el('div', { class: 'fill', style: `width:${Math.max(3, (count / max) * 100)}%` }));
    row.appendChild(track);
    row.appendChild(el('div', { class: 'num', text: String(count) }));
    if (opts && opts.onClick) { row.style.cursor = 'pointer'; row.addEventListener('click', () => opts.onClick(label)); }
    container.appendChild(row);
  });
  if (!entries.length) container.appendChild(el('div', { class: 'small', text: 'No data for the current filters.' }));
}

// ---------------------------------------------------------------------------
// Sidebar filter facets
// ---------------------------------------------------------------------------
const MULTISELECT_FIELDS = {
  family: (r) => [r.family],
  genus: (r) => [r.genus],
  acceptorClass: (r) => [r.acceptorClass],
  donor: (r) => r.acceptedDonors,
  metal: (r) => r.acceptedMetals,
};

function renderSidebarFacets() {
  const filteredExceptSelf = {}; // per-field, records filtered by every OTHER active filter (cascading counts)
  for (const field of Object.keys(MULTISELECT_FIELDS)) {
    const f = { ...state.filters };
    f[field] = new Set(); // ignore this field's own selection when counting its own options
    filteredExceptSelf[field] = applyFilters(state.records).length ? applyFilters(state.records) : [];
  }
  for (const field of Object.keys(MULTISELECT_FIELDS)) {
    const container = document.querySelector(`.multiselect[data-field="${field}"]`);
    if (!container) continue;
    const savedFilters = state.filters;
    const tempFilters = { ...savedFilters, [field]: new Set() };
    const prevFilters = state.filters; state.filters = tempFilters;
    const baseRecords = applyFilters(state.records);
    state.filters = prevFilters;

    const counts = new Map();
    baseRecords.forEach((r) => { MULTISELECT_FIELDS[field](r).forEach((v) => { if (v) counts.set(v, (counts.get(v) || 0) + 1); }); });
    const options = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    container.innerHTML = '';
    options.forEach(([value, count]) => {
      const id = `ms-${field}-${value}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      const item = el('label', { class: 'ms-item', for: id });
      const cb = el('input', { type: 'checkbox', id });
      cb.checked = state.filters[field].has(value);
      cb.addEventListener('change', () => {
        if (cb.checked) state.filters[field].add(value); else state.filters[field].delete(value);
        renderAll();
      });
      item.appendChild(cb);
      item.appendChild(el('span', { text: value }));
      item.appendChild(el('span', { class: 'cnt', text: String(count) }));
      container.appendChild(item);
    });
    if (!options.length) container.appendChild(el('div', { class: 'small', text: 'No values.' }));
  }
}

function renderKingdomButtons() {
  document.querySelectorAll('#f-kingdom button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.val === state.filters.kingdom);
  });
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------
function renderOverview(filtered) {
  const kpiRow = document.getElementById('kpiRow');
  const total = filtered.length;
  const plantFamilies = new Set(filtered.filter((r) => r.origin === 'Plant').map((r) => r.family).filter(Boolean)).size;
  const fungalFamilies = new Set(filtered.filter((r) => r.origin === 'Fungal').map((r) => r.family).filter(Boolean)).size;
  const genera = new Set(filtered.map((r) => r.genus).filter(Boolean)).size;
  const acceptorClasses = new Set(filtered.map((r) => r.acceptorClass).filter(Boolean)).size;
  kpiRow.innerHTML = '';
  [
    [total, 'Enzymes (filtered)'],
    [`${plantFamilies} / ${fungalFamilies}`, 'Plant / Fungal families'],
    [genera, 'Genera researched'],
    [acceptorClasses, 'Compound (acceptor) classes'],
  ].forEach(([v, l]) => kpiRow.appendChild(el('div', { class: 'kpi' }, [el('div', { class: 'v', text: String(v) }), el('div', { class: 'l', text: l })])));

  const famPlant = [...countBy(filtered.filter((r) => r.origin === 'Plant'), (r) => r.family)].sort((a, b) => b[1] - a[1]).slice(0, 25);
  const famFungal = [...countBy(filtered.filter((r) => r.origin === 'Fungal'), (r) => r.family)].sort((a, b) => b[1] - a[1]).slice(0, 25);
  renderBarList(document.getElementById('chartFamPlant'), famPlant, { onClick: (v) => toggleFacet('family', v) });
  renderBarList(document.getElementById('chartFamFungal'), famFungal, { cls: 'fungal', onClick: (v) => toggleFacet('family', v) });

  const acceptor = [...countBy(filtered, (r) => r.acceptorClass)].sort((a, b) => b[1] - a[1]).slice(0, 25);
  renderBarList(document.getElementById('chartAcceptor'), acceptor, { onClick: (v) => toggleFacet('acceptorClass', v) });

  const genusCounts = new Map();
  filtered.forEach((r) => { if (r.genus) genusCounts.set(r.genus, (genusCounts.get(r.genus) || 0) + 1); });
  const genusTop = [...genusCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  renderBarList(document.getElementById('chartGenus'), genusTop, { onClick: (v) => toggleFacet('genus', v) });
}

function toggleFacet(field, value) {
  if (state.filters[field].has(value)) state.filters[field].delete(value); else state.filters[field].add(value);
  renderAll();
}

// ---------------------------------------------------------------------------
// Families & Genera tab
// ---------------------------------------------------------------------------
function renderFamiliesGenera(filtered) {
  const famMap = new Map(); // family -> {kingdom, count, genera:Set}
  filtered.forEach((r) => {
    if (!r.family) return;
    const key = r.family + '||' + r.origin;
    if (!famMap.has(key)) famMap.set(key, { family: r.family, kingdom: r.origin, count: 0, genera: new Set() });
    const entry = famMap.get(key);
    entry.count++;
    if (r.genus) entry.genera.add(r.genus);
  });
  const famRows = [...famMap.values()].sort((a, b) => b.count - a.count);
  const famBody = document.querySelector('#tblFamilies tbody');
  famBody.innerHTML = '';
  famRows.forEach((f) => {
    famBody.appendChild(el('tr', {}, [
      el('td', { text: f.family }),
      el('td', { html: `<span class="tag ${f.kingdom === 'Plant' ? 'plant' : 'fungal'}">${f.kingdom || '—'}</span>` }),
      el('td', { text: String(f.count) }),
      el('td', { text: String(f.genera.size) }),
    ]));
  });

  const genusMap = new Map();
  filtered.forEach((r) => {
    if (!r.genus) return;
    const key = r.genus + '||' + r.origin;
    if (!genusMap.has(key)) genusMap.set(key, { genus: r.genus, kingdom: r.origin, families: new Set(), count: 0 });
    const entry = genusMap.get(key);
    entry.count++;
    if (r.family) entry.families.add(r.family);
  });
  const genusRows = [...genusMap.values()].sort((a, b) => b.count - a.count);
  const genusBody = document.querySelector('#tblGenera tbody');
  genusBody.innerHTML = '';
  genusRows.forEach((g) => {
    genusBody.appendChild(el('tr', {}, [
      el('td', { text: g.genus }),
      el('td', { html: `<span class="tag ${g.kingdom === 'Plant' ? 'plant' : 'fungal'}">${g.kingdom || '—'}</span>` }),
      el('td', { text: [...g.families].join(', ') }),
      el('td', { text: String(g.count) }),
    ]));
  });
}

// ---------------------------------------------------------------------------
// Compound lookup tab
// ---------------------------------------------------------------------------
function populateCompoundSelectors() {
  const accSel = document.getElementById('compoundAcceptorSelect');
  const donSel = document.getElementById('compoundDonorSelect');
  const accVals = [...new Set(state.records.map((r) => r.acceptorClass).filter(Boolean))].sort();
  const donVals = [...new Set(state.records.flatMap((r) => r.acceptedDonors))].sort();
  const prevAcc = accSel.value, prevDon = donSel.value;
  accSel.innerHTML = '<option value="">— choose —</option>' + accVals.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  donSel.innerHTML = '<option value="">— choose —</option>' + donVals.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  if (accVals.includes(prevAcc)) accSel.value = prevAcc;
  if (donVals.includes(prevDon)) donSel.value = prevDon;
}

function renderCompoundMatches(filtered) {
  const acc = document.getElementById('compoundAcceptorSelect').value;
  const don = document.getElementById('compoundDonorSelect').value;
  const body = document.querySelector('#tblCompoundMatches tbody');
  body.innerHTML = '';
  if (!acc && !don) { body.appendChild(el('tr', {}, [el('td', { colspan: '6', class: 'small', text: 'Choose a compound above to see matching enzymes.' })])); return; }
  const matches = filtered.filter((r) => (!acc || r.acceptorClass === acc) && (!don || r.acceptedDonors.includes(don)));
  if (!matches.length) { body.appendChild(el('tr', {}, [el('td', { colspan: '6', class: 'small', text: 'No enzymes match under the current filters.' })])); return; }
  matches.forEach((r) => {
    body.appendChild(el('tr', {}, [
      el('td', { text: r.enzyme || '—' }),
      el('td', { text: r.organism || '—' }),
      el('td', { text: r.family || '—' }),
      el('td', { html: `<span class="tag ${r.origin === 'Plant' ? 'plant' : 'fungal'}">${r.origin || '—'}</span>` }),
      el('td', { text: r.acceptorClass || '—' }),
      el('td', { text: r.acceptedDonors.join(', ') || '—' }),
    ]));
  });
}

// ---------------------------------------------------------------------------
// Data quality tab
// ---------------------------------------------------------------------------
function renderDataQuality() {
  const exactMap = new Map();
  state.records.forEach((r) => {
    const key = [r.enzyme, r.organism, r.acceptorClass].map((x) => (x || '').toLowerCase().trim()).join('||');
    if (!key.trim()) return;
    if (!exactMap.has(key)) exactMap.set(key, []);
    exactMap.get(key).push(r);
  });
  const exactDupes = [...exactMap.values()].filter((group) => group.length > 1);
  const exactContainer = document.getElementById('dupExact');
  exactContainer.innerHTML = '';
  if (!exactDupes.length) {
    exactContainer.appendChild(el('div', { class: 'notice ok', text: 'No exact duplicate rows found.' }));
  } else {
    exactDupes.forEach((group) => {
      exactContainer.appendChild(el('div', { class: 'notice warn', text: `${group.length}× "${group[0].enzyme}" — ${group[0].organism || 'unknown organism'} — ${group[0].acceptorClass || 'unknown acceptor class'} (S.No. ${group.map((r) => r.id).join(', ')})` }));
    });
  }

  renderSimilarPanel('dupFamily', state.records.map((r) => r.family));
  renderSimilarPanel('dupGenus', state.records.map((r) => r.genus));
  renderSimilarPanel('dupOrganism', state.records.map((r) => r.organism));
}

function renderSimilarPanel(containerId, values) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const pairs = findSimilarPairs(values);
  if (!pairs.length) { container.appendChild(el('div', { class: 'notice ok', text: 'No suspicious near-duplicates found.' })); return; }
  pairs.slice(0, 30).forEach((p) => {
    container.appendChild(el('div', { class: 'dupe-pair' }, [
      el('span', { html: `"<b>${escapeHtml(p.a)}</b>" vs "<b>${escapeHtml(p.b)}</b>"` }),
      el('span', { class: 'small', text: `edit distance ${p.dist}` }),
    ]));
  });
}

// ---------------------------------------------------------------------------
// Record browser tab
// ---------------------------------------------------------------------------
const BROWSER_COLUMNS = [
  { key: 'id', label: 'S.No' }, { key: 'enzyme', label: 'Enzyme' }, { key: 'origin', label: 'Kingdom' },
  { key: 'family', label: 'Family' }, { key: 'organism', label: 'Organism' }, { key: 'genus', label: 'Genus' },
  { key: 'acceptorClass', label: 'Acceptor class' }, { key: 'year', label: 'Year' },
];
let browserSort = { key: 'id', dir: 1 };

function renderBrowser(filtered) {
  document.getElementById('browserCount').textContent = `${filtered.length} record${filtered.length === 1 ? '' : 's'}`;
  const thead = document.querySelector('#tblBrowser thead');
  thead.innerHTML = '';
  const headRow = el('tr');
  BROWSER_COLUMNS.forEach((c) => {
    const th = el('th', { text: c.label + (browserSort.key === c.key ? (browserSort.dir === 1 ? ' ▲' : ' ▼') : '') });
    th.addEventListener('click', () => {
      if (browserSort.key === c.key) browserSort.dir *= -1; else { browserSort.key = c.key; browserSort.dir = 1; }
      renderBrowser(currentFiltered());
    });
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const sorted = [...filtered].sort((a, b) => {
    const av = a[browserSort.key], bv = b[browserSort.key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * browserSort.dir;
    return String(av).localeCompare(String(bv)) * browserSort.dir;
  });

  const tbody = document.querySelector('#tblBrowser tbody');
  tbody.innerHTML = '';
  sorted.forEach((r) => {
    const row = el('tr', { style: 'cursor:pointer' });
    BROWSER_COLUMNS.forEach((c) => {
      if (c.key === 'origin') row.appendChild(el('td', { html: `<span class="tag ${r.origin === 'Plant' ? 'plant' : 'fungal'}">${r.origin || '—'}</span>` }));
      else row.appendChild(el('td', { text: r[c.key] != null ? String(r[c.key]) : '—' }));
    });
    let detailRow = null;
    row.addEventListener('click', () => {
      if (detailRow) { detailRow.remove(); detailRow = null; return; }
      detailRow = buildDetailRow(r);
      row.after(detailRow);
    });
    tbody.appendChild(row);
  });
}

function buildDetailRow(r) {
  const tr = el('tr', { class: 'detail-row' });
  const td = el('td', { colspan: String(BROWSER_COLUMNS.length) });
  const kv = el('dl', { class: 'kv' });
  const rows = [
    ['Accepted acceptors', r.acceptedAcceptors.join('; ') || '—'],
    ['Medium/not accepted acceptors', r.mediumAcceptors.join('; ') || '—'],
    ['Accepted donors', r.acceptedDonors.join(', ') || '—'],
    ['Medium/not accepted donors', r.mediumDonors.join(', ') || '—'],
    ['Accepted metal ions', r.acceptedMetals.join(', ') || '—'],
    ['Expression host', r.expressionHost || '—'],
    ['Product', r.product || '—'],
    ['Regio specificity', r.regioRaw || '—'],
    ['Km value', r.kmRaw || '—'],
    ['Optimal pH', r.phRaw || '—'],
    ['Optimal temperature', r.tempRaw || '—'],
    ['Author', r.author || '—'],
    ['DOI', r.doi || '—'],
  ];
  rows.forEach(([k, v]) => { kv.appendChild(el('dt', { text: k })); kv.appendChild(el('dd', { text: v })); });
  td.appendChild(kv);
  tr.appendChild(td);
  return tr;
}

// ---------------------------------------------------------------------------
// Add record
// ---------------------------------------------------------------------------
function checkNearDuplicateName(newValue, existingValues, label) {
  if (!newValue) return null;
  const distinct = [...new Set(existingValues.filter(Boolean))];
  if (distinct.some((v) => v.toLowerCase() === newValue.toLowerCase())) return null; // exact match, fine
  let best = null;
  distinct.forEach((v) => {
    const maxLen = Math.max(v.length, newValue.length);
    if (maxLen < 4) return;
    const dist = levenshtein(v.toLowerCase(), newValue.toLowerCase());
    const threshold = maxLen <= 8 ? 1 : maxLen <= 16 ? 2 : 3;
    if (dist > 0 && dist <= threshold && (!best || dist < best.dist)) best = { value: v, dist };
  });
  if (best) return `"${newValue}" ${label} looks similar to the existing "${best.value}" (edit distance ${best.dist}) — possible typo. The record was still added; please double-check the spelling.`;
  return null;
}

function initAddRecordForm() {
  const form = document.getElementById('addRecordForm');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const notice = document.getElementById('addRecordNotice');
    notice.innerHTML = '';
    const body = {
      enzyme: document.getElementById('ar-enzyme').value.trim(),
      origin: document.getElementById('ar-origin').value,
      family: document.getElementById('ar-family').value.trim(),
      organism: document.getElementById('ar-organism').value.trim(),
      acceptorClass: document.getElementById('ar-acceptorClass').value.trim(),
      expressionHost: document.getElementById('ar-expressionHost').value.trim(),
      acceptorAccepted: document.getElementById('ar-acceptorAccepted').value.trim(),
      acceptorMedium: document.getElementById('ar-acceptorMedium').value.trim(),
      donorAccepted: document.getElementById('ar-donorAccepted').value.trim(),
      donorMedium: document.getElementById('ar-donorMedium').value.trim(),
      metalAccepted: document.getElementById('ar-metalAccepted').value.trim(),
      metalMedium: document.getElementById('ar-metalMedium').value.trim(),
      product: document.getElementById('ar-product').value.trim(),
      regio: document.getElementById('ar-regio').value.trim(),
      km: document.getElementById('ar-km').value.trim(),
      ph: document.getElementById('ar-ph').value.trim(),
      temperature: document.getElementById('ar-temperature').value.trim(),
      year: document.getElementById('ar-year').value.trim(),
      author: document.getElementById('ar-author').value.trim(),
      doi: document.getElementById('ar-doi').value.trim(),
    };
    if (!body.enzyme) { notice.appendChild(el('div', { class: 'notice danger', text: 'Enzyme name is required.' })); return; }
    if (body.origin !== 'P' && body.origin !== 'F') { notice.appendChild(el('div', { class: 'notice danger', text: 'Origin must be Plant or Fungal.' })); return; }

    const warnings = [];
    const famWarn = checkNearDuplicateName(body.family, state.records.map((r) => r.family), 'family name');
    if (famWarn) warnings.push(famWarn);
    const { genus } = splitOrganism(body.organism);
    const genusWarn = checkNearDuplicateName(genus, state.records.map((r) => r.genus), 'genus');
    if (genusWarn) warnings.push(genusWarn);
    const exactDup = state.records.find((r) => (r.enzyme || '').toLowerCase() === body.enzyme.toLowerCase() && (r.organism || '').toLowerCase() === body.organism.toLowerCase());
    if (exactDup) warnings.push(`This looks like an exact duplicate of existing S.No. ${exactDup.id} (${exactDup.enzyme} — ${exactDup.organism}). Record was still added.`);

    const maxSno = state.rawRows.reduce((max, r) => Math.max(max, Number(r['S. No.']) || 0), 0);
    const newRow = { 'S. No.': maxSno + 1 };
    for (const [formField, column] of Object.entries(FORM_FIELD_TO_COLUMN)) {
      const val = body[formField];
      newRow[column] = val === '' || val == null ? null : val;
    }
    newRow['Origin'] = body.origin;
    newRow['Enzyme'] = body.enzyme;

    state.rawRows.push(newRow);
    rebuildRecords();
    persist();
    renderAll();

    warnings.forEach((w) => notice.appendChild(el('div', { class: 'notice warn', text: w })));
    notice.appendChild(el('div', { class: 'notice ok', text: `Added as S.No. ${maxSno + 1}. Total records: ${state.rawRows.length}. Don't forget to Export the updated file when you're done.` }));
    form.reset();
  });
  document.getElementById('ar-resetBtn').addEventListener('click', () => { form.reset(); document.getElementById('addRecordNotice').innerHTML = ''; });
}

function refreshDatalists() {
  document.getElementById('dl-family').innerHTML = [...new Set(state.records.map((r) => r.family).filter(Boolean))].sort().map((v) => `<option value="${escapeHtml(v)}">`).join('');
  document.getElementById('dl-organism').innerHTML = [...new Set(state.records.map((r) => r.organism).filter(Boolean))].sort().map((v) => `<option value="${escapeHtml(v)}">`).join('');
  document.getElementById('dl-acceptorClass').innerHTML = [...new Set(state.records.map((r) => r.acceptorClass).filter(Boolean))].sort().map((v) => `<option value="${escapeHtml(v)}">`).join('');
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function buildAoa() {
  return [REQUIRED_COLUMNS, ...state.rawRows.map((r) => REQUIRED_COLUMNS.map((col) => (r[col] == null ? '' : r[col])))];
}

function exportXlsx() {
  const aoa = buildAoa();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tabelle1');
  XLSX.writeFile(wb, `enzyme-database-${dateStamp()}.xlsx`);
}

function exportCsv() {
  const aoa = buildAoa();
  const csv = aoa.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `enzyme-database-${dateStamp()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function dateStamp() { return new Date().toISOString().slice(0, 10); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------
function handleFileLoad(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
      const cleaned = rows
        .map((r) => { const out = {}; REQUIRED_COLUMNS.forEach((c) => { out[c] = r[c] === undefined ? null : r[c]; }); return out; })
        .filter((r) => r['Enzyme'] || r['S. No.']);
      if (!cleaned.length) { alert('No rows recognized. Make sure the file has the expected column headers (same as the source PT workbook).'); return; }
      state.rawRows = cleaned;
      persist();
      rebuildRecords();
      resetAllFilters(false);
      renderAll();
    } catch (err) {
      alert('Could not read this file: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function resetAllFilters(rerender) {
  state.filters = { kingdom: 'All', family: new Set(), genus: new Set(), acceptorClass: new Set(), donor: new Set(), metal: new Set(), search: '' };
  document.getElementById('searchBox').value = '';
  if (rerender !== false) renderAll();
}

function updateStatusPill() {
  const pill = document.getElementById('statusPill');
  const hasData = state.rawRows.length > 0;
  document.getElementById('emptyState').style.display = hasData ? 'none' : 'block';
  document.getElementById('appContent').style.display = hasData ? '' : 'none';
  document.getElementById('exportXlsxBtn').disabled = !hasData;
  document.getElementById('exportCsvBtn').disabled = !hasData;
  document.getElementById('clearDataBtn').disabled = !hasData;
  if (hasData) { pill.textContent = `${state.rawRows.length} records loaded`; pill.className = 'status-pill ok'; }
  else { pill.textContent = 'No data loaded'; pill.className = 'status-pill'; }
}

function renderAll() {
  updateStatusPill();
  if (!state.rawRows.length) return;
  renderKingdomButtons();
  renderSidebarFacets();
  const filtered = currentFiltered();
  document.getElementById('filterSummary').textContent = `Showing ${filtered.length} of ${state.records.length} records`;
  renderOverview(filtered);
  renderFamiliesGenera(filtered);
  populateCompoundSelectors();
  renderCompoundMatches(filtered);
  renderDataQuality();
  renderBrowser(filtered);
  refreshDatalists();
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('on'));
      document.querySelectorAll('.page').forEach((p) => p.classList.remove('on'));
      btn.classList.add('on');
      document.getElementById('page-' + btn.dataset.tab).classList.add('on');
    });
  });
}

function init() {
  initTabs();
  initAddRecordForm();

  document.getElementById('fileInput').addEventListener('change', (e) => { if (e.target.files[0]) handleFileLoad(e.target.files[0]); e.target.value = ''; });
  document.getElementById('exportXlsxBtn').addEventListener('click', exportXlsx);
  document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
  document.getElementById('clearDataBtn').addEventListener('click', () => {
    if (!confirm('Clear all loaded data (including any records you added)? This cannot be undone.')) return;
    state.rawRows = []; state.records = [];
    localStorage.removeItem(STORAGE_KEY);
    resetAllFilters(false);
    renderAll();
  });
  document.getElementById('resetFiltersBtn').addEventListener('click', () => resetAllFilters());
  document.getElementById('searchBox').addEventListener('input', (e) => { state.filters.search = e.target.value; renderAll(); });
  document.querySelectorAll('#f-kingdom button').forEach((btn) => btn.addEventListener('click', () => { state.filters.kingdom = btn.dataset.val; renderAll(); }));
  document.getElementById('compoundAcceptorSelect').addEventListener('change', () => renderCompoundMatches(currentFiltered()));
  document.getElementById('compoundDonorSelect').addEventListener('change', () => renderCompoundMatches(currentFiltered()));

  const hadStorage = loadFromStorage();
  if (!hadStorage) loadEmbeddedDefault();
  rebuildRecords();
  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
