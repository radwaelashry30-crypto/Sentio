'use strict';

/* =========================================================================
   State
   ========================================================================= */
const DEFAULT_FILTERS = {
  kingdom: 'All', family: [], genus: [], species: [], acceptorClass: [],
  donor: [], donorRole: 'accepted', metal: [], regioPosition: [], host: [], completeness: [],
  yearFrom: null, yearTo: null, promiscuousDmapp: false, search: '', includeMissing: true,
};
let filters = loadFiltersFromUrl();
let filterHistory = [];
let currentTab = 'overview';
let browserState = { page: 1, pageSize: 25, sortField: 'id', sortDir: 'asc', total: 0 };
let datasetMeta = null;
let ws = null;

const MULTISELECT_FIELDS = ['family', 'genus', 'species', 'acceptorClass', 'donor', 'metal', 'regioPosition', 'host', 'completeness'];

/* =========================================================================
   URL / filter serialization
   ========================================================================= */
function loadFiltersFromUrl() {
  const params = new URLSearchParams(location.search);
  const f = JSON.parse(JSON.stringify(DEFAULT_FILTERS));
  for (const key of Object.keys(DEFAULT_FILTERS)) {
    if (!params.has(key)) continue;
    const raw = params.get(key);
    if (Array.isArray(f[key])) f[key] = raw ? raw.split(',').filter(Boolean) : [];
    else if (typeof f[key] === 'boolean') f[key] = raw === 'true';
    else f[key] = raw;
  }
  return f;
}

function filtersToParams(f) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v == null || v === '' ) continue;
    if (Array.isArray(v)) { if (v.length) params.set(k, v.join(',')); continue; }
    if (typeof v === 'boolean') { if (v) params.set(k, 'true'); continue; }
    params.set(k, v);
  }
  return params;
}

function syncUrl() {
  const params = filtersToParams(filters);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function api(path, extraParams, filterOverride) {
  const params = filtersToParams(filterOverride || filters);
  if (extraParams) for (const [k, v] of Object.entries(extraParams)) params.set(k, v);
  const qs = params.toString();
  return fetch(`${path}${qs ? `?${qs}` : ''}`).then((r) => {
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  });
}

/* =========================================================================
   Color system — deterministic per-value hashing so a category keeps the
   same color across every chart and every tab.
   ========================================================================= */
const CATEGORICAL_PALETTE = ['#56B4E9', '#E69F00', '#009E73', '#CC79A7', '#0072B2', '#D55E00', '#F0E442', '#8B98B3', '#36D399', '#A78BFA', '#F5B942', '#5FD4D0'];
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}
function colorFor(value) {
  if (value == null) return cssVar('--ink-faint');
  return CATEGORICAL_PALETTE[hashString(String(value)) % CATEGORICAL_PALETTE.length];
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}
const PLANT_COLOR = () => cssVar('--plant');
const FUNGAL_COLOR = () => cssVar('--fungal');

function plotlyLayout(extra = {}) {
  const base = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'Inter, sans-serif', color: cssVar('--ink-soft'), size: 11 },
    margin: { l: 56, r: 20, t: 10, b: 44 },
    xaxis: { gridcolor: cssVar('--line'), zerolinecolor: cssVar('--line'), color: cssVar('--ink-faint'), automargin: true },
    yaxis: { gridcolor: cssVar('--line'), zerolinecolor: cssVar('--line'), color: cssVar('--ink-faint'), automargin: true },
    legend: { font: { color: cssVar('--ink-soft'), size: 10 }, bgcolor: 'rgba(0,0,0,0)' },
    hoverlabel: { bgcolor: cssVar('--panel-2'), bordercolor: cssVar('--line-strong'), font: { color: cssVar('--ink') } },
    colorway: CATEGORICAL_PALETTE,
  };
  return deepMerge(base, extra);
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b || {})) {
    out[k] = (typeof a[k] === 'object' && !Array.isArray(a[k]) && a[k] && typeof b[k] === 'object') ? deepMerge(a[k], b[k]) : b[k];
  }
  return out;
}
const PLOTLY_CONFIG = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] };

function plot(id, traces, layout, opts) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!el.dataset.plotted) {
    Plotly.newPlot(el, traces, plotlyLayout(layout), PLOTLY_CONFIG);
    el.dataset.plotted = '1';
  } else {
    Plotly.react(el, traces, plotlyLayout(layout), PLOTLY_CONFIG);
  }
  if (opts && opts.onClick) {
    el.removeAllListeners && el.removeAllListeners('plotly_click');
    el.on('plotly_click', opts.onClick);
  }
}

/* =========================================================================
   Toasts
   ========================================================================= */
function toast(message, kind = 'info') {
  const region = document.getElementById('toastRegion');
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' error' : ''}`;
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

/* =========================================================================
   Status bar + WebSocket
   ========================================================================= */
const STAGE_LABEL = {
  idle: 'Idle', watching: 'Watching', change_detected: 'Change detected', validating: 'Validating',
  parsing: 'Parsing', updating_analysis: 'Updating analysis', updated: 'Updated', error: 'Error',
};

function setStatusDot(stage) {
  const dot = document.getElementById('statusDot');
  dot.classList.remove('ok', 'busy', 'err');
  if (stage === 'updated') dot.classList.add('ok');
  else if (stage === 'error') dot.classList.add('err');
  else if (stage && stage !== 'idle' && stage !== 'watching') dot.classList.add('busy');
}

function renderStatusText(stage) {
  document.getElementById('statusText').textContent = STAGE_LABEL[stage] || stage;
  setStatusDot(stage);
}

function renderStatusMeta(meta) {
  datasetMeta = meta;
  document.getElementById('sourceFileBadge').textContent = meta ? `file: ${meta.source_filename}` : '';
  document.getElementById('versionBadge').textContent = meta ? `v${meta.version} · ${meta.file_hash}` : '';
  document.getElementById('recordCountBadge').textContent = meta ? `${meta.record_count} records` : '';
  document.getElementById('refreshBadge').textContent = meta ? `refreshed ${new Date(meta.ingested_at).toLocaleString()}` : '';
}

async function loadStatus() {
  const s = await fetch('/api/dataset/status').then((r) => r.json());
  renderStatusText(s.status);
  renderStatusMeta(s.meta);
  renderActivityLog(s.activityLog);
  if (s.lastError) toast(`${s.lastError.message} — last valid dataset preserved.`, 'error');
}

function renderActivityLog(entries) {
  const ul = document.getElementById('activityLog');
  if (ul) {
    ul.innerHTML = (entries || []).map((e) =>
      `<li><span class="t">${new Date(e.at).toLocaleTimeString()}</span>${escapeHtml(e.message)}</li>`
    ).join('') || '<li>No activity yet.</li>';
  }
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'lifecycle') renderStatusText(msg.stage);
    else if (msg.type === 'status') { renderStatusText(msg.status); renderStatusMeta(msg.meta); }
    else if (msg.type === 'dataset_updated') {
      renderStatusText('updated');
      renderStatusMeta(msg.meta);
      toast(`Dataset updated — v${msg.meta.version}, ${msg.meta.record_count} records.`);
      refreshAll();
    } else if (msg.type === 'error') {
      renderStatusText('error');
      toast(`${msg.message} — last valid dataset preserved.`, 'error');
    }
  };
  ws.onclose = () => setTimeout(connectWS, 2000);
}

/* =========================================================================
   Upload
   ========================================================================= */
function initUpload() {
  const btn = document.getElementById('uploadBtn');
  const input = document.getElementById('fileInput');
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (!input.files.length) return;
    uploadFile(input.files[0]);
    input.value = '';
  });
}

function uploadFile(file) {
  const wrap = document.getElementById('uploadProgressWrap');
  const bar = document.getElementById('uploadProgressBar');
  const text = document.getElementById('uploadProgressText');
  wrap.hidden = false;
  bar.style.width = '0%';
  text.textContent = `Uploading ${file.name}…`;

  const form = new FormData();
  form.append('file', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      bar.style.width = `${pct}%`;
      text.textContent = `Uploading ${file.name}… ${pct}%`;
    }
  };
  xhr.onload = () => {
    wrap.hidden = true;
    try {
      const resp = JSON.parse(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300 && resp.ok) {
        toast(`Uploaded ${resp.sourceFilename} — v${resp.version}, ${resp.recordCount} records.`);
      } else {
        toast(`Upload rejected: ${resp.error}${resp.details && resp.details.length ? ' — ' + resp.details.join('; ') : ''}`, 'error');
      }
    } catch {
      toast('Upload failed: unexpected server response.', 'error');
    }
  };
  xhr.onerror = () => { wrap.hidden = true; toast('Upload failed: network error.', 'error'); };
  xhr.send(form);
}

/* =========================================================================
   Filter sidebar
   ========================================================================= */
function pushHistory() {
  filterHistory.push(JSON.parse(JSON.stringify(filters)));
  if (filterHistory.length > 20) filterHistory.shift();
}

function setFilter(field, value, { record = true } = {}) {
  if (record) pushHistory();
  filters[field] = value;
  onFiltersChanged();
}

function toggleMultiValue(field, value) {
  pushHistory();
  const set = new Set(filters[field]);
  if (set.has(value)) set.delete(value); else set.add(value);
  filters[field] = [...set];
  onFiltersChanged();
}

function onFiltersChanged() {
  syncUrl();
  renderChips();
  refreshFilterOptions();
  refreshAll();
}

function renderChips() {
  const chips = [];
  if (filters.kingdom && filters.kingdom !== 'All') chips.push(['kingdom', filters.kingdom, () => setFilter('kingdom', 'All')]);
  for (const f of MULTISELECT_FIELDS) {
    for (const v of filters[f]) chips.push([f, v, () => toggleMultiValue(f, v)]);
  }
  if (filters.yearFrom || filters.yearTo) chips.push(['year', `${filters.yearFrom || '…'}–${filters.yearTo || '…'}`, () => { setFilter('yearFrom', null, { record: false }); setFilter('yearTo', null); }]);
  if (filters.promiscuousDmapp) chips.push(['flag', 'promiscuous DMAPP', () => setFilter('promiscuousDmapp', false)]);
  if (filters.search) chips.push(['search', filters.search, () => setFilter('search', '')]);

  document.getElementById('activeChips').innerHTML = chips.map(([label, val], i) =>
    `<span class="active-chip" data-i="${i}">${escapeHtml(label)}: ${escapeHtml(String(val))} <button aria-label="Remove filter">×</button></span>`
  ).join('');
  [...document.getElementById('activeChips').children].forEach((el, i) => {
    el.querySelector('button').addEventListener('click', chips[i][2]);
  });

  // Reflect checkbox/segmented UI state
  document.querySelectorAll('#f-kingdom .seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.value === (filters.kingdom || 'All')));
  document.querySelectorAll('#f-donorRole .seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.value === filters.donorRole));
  document.getElementById('f-year-from').value = filters.yearFrom || '';
  document.getElementById('f-year-to').value = filters.yearTo || '';
  document.getElementById('f-promiscuous').checked = !!filters.promiscuousDmapp;
  document.getElementById('f-search').value = filters.search || '';
  document.getElementById('f-includeMissing').checked = filters.includeMissing !== false;
}

let filterOptionsCache = {};
async function refreshFilterOptions() {
  const results = await Promise.all(MULTISELECT_FIELDS.map((field) => {
    const paramsWithoutField = { ...filters, [field]: [] };
    return api('/api/dataset/filter-options', null, paramsWithoutField);
  }));
  MULTISELECT_FIELDS.forEach((field, i) => {
    filterOptionsCache[field] = results[i][field] || [];
    renderMultiselect(field);
  });
  const anyOpts = results[0];
  if (anyOpts && Number.isFinite(anyOpts.yearMin)) {
    const from = document.getElementById('f-year-slider-from');
    const to = document.getElementById('f-year-slider-to');
    from.min = to.min = anyOpts.yearMin; from.max = to.max = anyOpts.yearMax;
    if (!from.dataset.touched) from.value = anyOpts.yearMin;
    if (!to.dataset.touched) to.value = anyOpts.yearMax;
  }
}

function renderMultiselect(field) {
  const container = document.querySelector(`.multiselect[data-field="${field}"]`);
  if (!container) return;
  const options = filterOptionsCache[field] || [];
  const selected = new Set(filters[field]);
  const searchVal = container.querySelector('.ms-search')?.value || '';
  const filtered = searchVal ? options.filter((o) => String(o).toLowerCase().includes(searchVal.toLowerCase())) : options;

  container.innerHTML = `
    <input type="text" class="ms-search" placeholder="Search ${field}…" value="${escapeAttr(searchVal)}">
    <div class="ms-options">
      ${filtered.slice(0, 300).map((o) => `
        <label class="ms-option">
          <input type="checkbox" value="${escapeAttr(o)}" ${selected.has(o) ? 'checked' : ''}>
          <span>${escapeHtml(String(o))}</span>
        </label>
      `).join('') || '<div class="ms-option">No options</div>'}
    </div>`;

  container.querySelector('.ms-search').addEventListener('input', (e) => {
    const cursorField = field;
    const val = e.target.value;
    // Re-render just the options list without losing focus.
    const opts = (filterOptionsCache[cursorField] || []).filter((o) => String(o).toLowerCase().includes(val.toLowerCase()));
    const sel = new Set(filters[cursorField]);
    container.querySelector('.ms-options').innerHTML = opts.slice(0, 300).map((o) => `
      <label class="ms-option">
        <input type="checkbox" value="${escapeAttr(o)}" ${sel.has(o) ? 'checked' : ''}>
        <span>${escapeHtml(String(o))}</span>
      </label>`).join('') || '<div class="ms-option">No options</div>';
    container.querySelectorAll('.ms-option input').forEach((cb) => {
      cb.addEventListener('change', () => toggleMultiValue(cursorField, cb.value));
    });
  });
  container.querySelectorAll('.ms-option input').forEach((cb) => {
    cb.addEventListener('change', () => toggleMultiValue(field, cb.value));
  });
}

function initFilterControls() {
  document.getElementById('f-kingdom').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return;
    setFilter('kingdom', btn.dataset.value);
  });
  document.getElementById('f-donorRole').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn'); if (!btn) return;
    setFilter('donorRole', btn.dataset.value);
  });
  document.getElementById('f-year-from').addEventListener('change', (e) => setFilter('yearFrom', e.target.value ? Number(e.target.value) : null));
  document.getElementById('f-year-to').addEventListener('change', (e) => setFilter('yearTo', e.target.value ? Number(e.target.value) : null));
  ['f-year-slider-from', 'f-year-slider-to'].forEach((id) => {
    document.getElementById(id).addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
    document.getElementById(id).addEventListener('change', () => {
      const from = Number(document.getElementById('f-year-slider-from').value);
      const to = Number(document.getElementById('f-year-slider-to').value);
      pushHistory();
      filters.yearFrom = Math.min(from, to);
      filters.yearTo = Math.max(from, to);
      onFiltersChanged();
    });
  });
  document.getElementById('f-promiscuous').addEventListener('change', (e) => setFilter('promiscuousDmapp', e.target.checked));
  let searchDebounce;
  document.getElementById('f-search').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => setFilter('search', e.target.value, { record: false }), 300);
  });
  document.getElementById('f-includeMissing').addEventListener('change', (e) => setFilter('includeMissing', e.target.checked));
  document.getElementById('f-entityCounts').addEventListener('change', () => { if (currentTab === 'bivariate') renderBivariate(); });

  document.getElementById('clearAllBtn').addEventListener('click', () => {
    pushHistory();
    filters = JSON.parse(JSON.stringify(DEFAULT_FILTERS));
    onFiltersChanged();
  });
  document.getElementById('undoFilterBtn').addEventListener('click', () => {
    if (!filterHistory.length) return toast('Nothing to undo.');
    filters = filterHistory.pop();
    syncUrl(); renderChips(); refreshFilterOptions(); refreshAll();
  });
  document.getElementById('presetBtn').addEventListener('click', () => {
    const name = prompt('Name this filter preset:');
    if (!name) return;
    const presets = JSON.parse(localStorage.getItem('pt_presets') || '{}');
    presets[name] = filters;
    localStorage.setItem('pt_presets', JSON.stringify(presets));
    renderPresets();
    toast(`Saved preset "${name}".`);
  });
  document.getElementById('exportCsvBtn').addEventListener('click', (e) => {
    e.preventDefault();
    const params = filtersToParams(filters);
    window.location.href = `/api/records/export.csv?${params.toString()}`;
  });
  renderPresets();
}

function renderPresets() {
  const presets = JSON.parse(localStorage.getItem('pt_presets') || '{}');
  const el = document.getElementById('presetList');
  el.innerHTML = Object.keys(presets).map((name) =>
    `<span class="active-chip"><button class="preset-load" data-name="${escapeAttr(name)}" style="background:none;border:none;color:inherit;cursor:pointer;">${escapeHtml(name)}</button><button class="preset-del" data-name="${escapeAttr(name)}">×</button></span>`
  ).join('');
  el.querySelectorAll('.preset-load').forEach((b) => b.addEventListener('click', () => {
    pushHistory();
    filters = JSON.parse(JSON.stringify(presets[b.dataset.name]));
    onFiltersChanged();
  }));
  el.querySelectorAll('.preset-del').forEach((b) => b.addEventListener('click', () => {
    const p = JSON.parse(localStorage.getItem('pt_presets') || '{}');
    delete p[b.dataset.name];
    localStorage.setItem('pt_presets', JSON.stringify(p));
    renderPresets();
  }));
}

/* =========================================================================
   Tabs
   ========================================================================= */
function initTabs() {
  document.getElementById('tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn'); if (!btn) return;
    switchTab(btn.dataset.tab);
  });
  document.getElementById('quickLinks').addEventListener('click', (e) => {
    const btn = e.target.closest('.quick-link-btn'); if (!btn) return;
    switchTab(btn.dataset.tab);
  });
}
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.id === `page-${tab}`));
  renderTab(tab);
}
function renderTab(tab) {
  if (tab === 'overview') renderOverview();
  else if (tab === 'eda') renderEda();
  else if (tab === 'cleaning') renderCleaning();
  else if (tab === 'bivariate') renderBivariate();
  else if (tab === 'stats') renderStats();
  else if (tab === 'insights') renderInsights();
  else if (tab === 'literature') renderLiterature();
  else if (tab === 'browser') renderBrowser();
  else if (tab === 'ask') { /* no-op: askQuestion runs on demand via the Ask button */ }
  else if (tab === 'addrecord') { /* no-op: static form, submit runs on demand */ }
}
function refreshAll() {
  renderKpiRow();
  renderTab(currentTab);
}

/* =========================================================================
   KPI row (header) + filter count/summary
   ========================================================================= */
async function renderKpiRow() {
  const summary = await api('/api/dataset/summary');
  const k = summary.kpis;
  document.getElementById('kpiRow').innerHTML = `
    <div class="kpi"><div class="v">${k.total}</div><div class="l">Records</div></div>
    <div class="kpi"><div class="v">${k.plant} / ${k.fungal}</div><div class="l">Plant / Fungal</div></div>
    <div class="kpi"><div class="v">${k.plantFamilies}</div><div class="l">Plant families</div></div>
    <div class="kpi"><div class="v">${k.acceptorClasses}</div><div class="l">Acceptor classes</div></div>
    <div class="kpi"><div class="v">${k.yearMin ?? '—'}–${k.yearMax ?? '—'}</div><div class="l">Publication span</div></div>
    <div class="kpi"><div class="v">${k.enzymesWithFullKmPair}</div><div class="l">Full K<sub>m</sub> pairs</div></div>
  `;
  const total = summary.kpisUnfiltered.total;
  document.getElementById('filterCount').textContent = `Showing ${k.total} of ${total} records`;
  const bits = [];
  if (filters.kingdom && filters.kingdom !== 'All') bits.push(filters.kingdom);
  ['family', 'acceptorClass', 'donor'].forEach((f) => { if (filters[f].length) bits.push(filters[f].join('/')); });
  document.getElementById('filterSummary').textContent = bits.length ? `Showing ${k.total} of ${total} records — ${bits.join(' · ')}` : '';
}

/* =========================================================================
   Overview tab
   ========================================================================= */
async function renderOverview() {
  const status = await fetch('/api/dataset/status').then((r) => r.json());
  const summary = await api('/api/dataset/summary');
  const meta = status.meta || {};
  document.getElementById('overviewStatus').innerHTML = kv({
    'Source file': meta.source_filename || '—', 'Version': meta.version ?? '—', 'File hash': meta.file_hash || '—',
    'Record count': meta.record_count ?? '—', 'Plant / Fungal': meta.plant_count != null ? `${meta.plant_count} / ${meta.fungal_count}` : '—',
    'Ingested at': meta.ingested_at ? new Date(meta.ingested_at).toLocaleString() : '—',
    'Processing state': STAGE_LABEL[status.status] || status.status,
    'Manual review items': summary.manualReviewCount,
  });
  renderActivityLog(status.activityLog);
  const k = summary.kpis;
  document.getElementById('overviewKpiCards').innerHTML = `
    <div class="card stat-card"><div class="big">${k.total}</div><div class="lbl">Characterized enzymes</div><div class="sub">${k.plant} plant · ${k.fungal} fungal</div></div>
    <div class="card stat-card"><div class="big">${k.plantFamilies}</div><div class="lbl">Plant families</div><div class="sub">${k.plantGenera} plant genera</div></div>
    <div class="card stat-card"><div class="big">${k.acceptorClasses}</div><div class="lbl">Acceptor classes</div><div class="sub">after label normalization</div></div>
    <div class="card stat-card"><div class="big">${k.yearMin ?? '—'}–${k.yearMax ?? '—'}</div><div class="lbl">Publication span</div><div class="sub">of current filtered set</div></div>
    <div class="card stat-card"><div class="big">${k.enzymesWithFullKmPair}</div><div class="lbl">Enzymes with full K<sub>m</sub> pair</div><div class="sub">donor + acceptor extractable</div></div>
  `;

  const h = summary.highlights;
  document.getElementById('overviewHighlights').innerHTML = kv({
    'Top acceptor class': h.topAcceptorClass ? `${h.topAcceptorClass.value} (${h.topAcceptorClass.count})` : '—',
    'Top plant family': h.topFamily ? `${h.topFamily.value} (${h.topFamily.count})` : '—',
    'Top donor': h.topDonor ? `${h.topDonor.value} (${h.topDonor.count})` : '—',
    'Top metal ion': h.topMetal ? `${h.topMetal.value} (${h.topMetal.count})` : '—',
    'C- vs O-prenylation': `${h.cPrenylationCount} C / ${h.oPrenylationCount} O`,
    'Full data profile': `${h.completeRecords} of ${h.totalRecords} complete`,
  });

  const flagsEl = document.getElementById('overviewFlags');
  const flags = [];
  if (h.promiscuousDmappCount > 0) {
    flags.push({ n: h.promiscuousDmappCount, text: 'record(s) heuristically flagged as promiscuous DMAPP acceptors (DMAPP + ≥4 accepted aromatic substrates) — confirm against the source publication.' });
  }
  if (h.hasAhpt1SpecialCase) {
    flags.push({ n: 1, text: 'record (AhPT1) is a manually curated cofactor-dependent special case — Mg²⁺ and Mn²⁺ produce different regiochemistry on different substrates; see the Data Cleaning tab.' });
  }
  if (summary.manualReviewCount > 0) {
    flags.push({ n: summary.manualReviewCount, text: 'total items on the manual-review list (pH/temperature auto-swaps, unrecognized tokens, and the above) — see the Data Cleaning &amp; Parsing tab.' });
  }
  flagsEl.innerHTML = flags.length
    ? flags.map((f) => `<div class="flag-item"><span class="n">${f.n}</span><span>${f.text}</span></div>`).join('')
    : '<p class="cap">No special-case flags in the current filtered set.</p>';
}
function kv(obj) {
  return Object.entries(obj).map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(String(v))}</div>`).join('');
}

/* =========================================================================
   EDA tab
   ========================================================================= */
async function renderEda() {
  const [records, entitiesDonor, entitiesMetal] = await Promise.all([
    api('/api/records', { pageSize: 500 }),
    api('/api/records/entities/donors'),
    api('/api/records/entities/metals'),
  ]);
  const rows = records.rows;

  const byOrigin = groupCount(rows, (r) => r.origin);
  plot('c-origin', [{
    type: 'pie', labels: Object.keys(byOrigin), values: Object.values(byOrigin), hole: 0.55,
    marker: { colors: Object.keys(byOrigin).map((o) => o === 'Plant' ? PLANT_COLOR() : FUNGAL_COLOR()) },
    textinfo: 'label+percent',
  }], {}, { onClick: (d) => setFilter('kingdom', d.points[0].label) });

  const byYear = groupCount(rows, (r) => r.year);
  const years = Object.keys(byYear).filter((y) => y !== 'null').sort();
  plot('c-yearbar', [{ type: 'bar', x: years, y: years.map((y) => byYear[y]), marker: { color: PLANT_COLOR() } }],
    { xaxis: { title: 'Year' }, yaxis: { title: 'Records' } },
    { onClick: (d) => { pushHistory(); filters.yearFrom = filters.yearTo = Number(d.points[0].x); onFiltersChanged(); } });

  const byHost = groupCount(rows, (r) => r.expressionHost || 'Unknown');
  const hostEntries = Object.entries(byHost).sort((a, b) => b[1] - a[1]);
  plot('c-host', [{ type: 'bar', orientation: 'h', y: hostEntries.map((e) => e[0]), x: hostEntries.map((e) => e[1]),
    marker: { color: hostEntries.map((e) => colorFor(e[0])) } }],
    { margin: { l: 120, r: 20, t: 10, b: 40 } },
    { onClick: (d) => toggleMultiValue('host', d.points[0].y) });

  const acceptorByOrigin = {};
  rows.forEach((r) => { if (!r.acceptorClass) return; (acceptorByOrigin[r.acceptorClass] ??= { Plant: 0, Fungal: 0 })[r.origin]++; });
  const accClasses = Object.keys(acceptorByOrigin).sort((a, b) => (acceptorByOrigin[b].Plant + acceptorByOrigin[b].Fungal) - (acceptorByOrigin[a].Plant + acceptorByOrigin[a].Fungal));
  plot('c-type', [
    { type: 'bar', name: 'Plant', y: accClasses, x: accClasses.map((c) => acceptorByOrigin[c].Plant), orientation: 'h', marker: { color: PLANT_COLOR() } },
    { type: 'bar', name: 'Fungal', y: accClasses, x: accClasses.map((c) => acceptorByOrigin[c].Fungal), orientation: 'h', marker: { color: FUNGAL_COLOR() } },
  ], { barmode: 'stack', margin: { l: 160, r: 20, t: 10, b: 40 } }, { onClick: (d) => toggleMultiValue('acceptorClass', d.points[0].y) });

  const famCounts = groupCount(rows.filter((r) => r.origin === 'Plant'), (r) => r.family || 'Unknown');
  plot('c-famtree', [{ type: 'treemap', labels: Object.keys(famCounts), parents: Object.keys(famCounts).map(() => ''), values: Object.values(famCounts),
    marker: { colors: Object.keys(famCounts).map((f) => colorFor(f)) } }], {}, { onClick: (d) => toggleMultiValue('family', d.points[0].label) });

  const donorFreq = groupCount(entitiesDonor.rows, (r) => r.donor);
  const donorEntries = Object.entries(donorFreq).sort((a, b) => b[1] - a[1]);
  plot('c-donor', [{ type: 'bar', x: donorEntries.map((e) => e[0]), y: donorEntries.map((e) => e[1]), marker: { color: donorEntries.map((e) => colorFor(e[0])) } }],
    {}, { onClick: (d) => toggleMultiValue('donor', d.points[0].x) });

  const donorByKingdom = {};
  entitiesDonor.rows.forEach((r) => { (donorByKingdom[r.donor] ??= { Plant: 0, Fungal: 0 })[r.origin]++; });
  const donorKeys = Object.keys(donorByKingdom).sort((a, b) => (donorByKingdom[b].Plant + donorByKingdom[b].Fungal) - (donorByKingdom[a].Plant + donorByKingdom[a].Fungal));
  plot('c-donorking', [
    { type: 'bar', name: 'Plant', x: donorKeys, y: donorKeys.map((k) => donorByKingdom[k].Plant), marker: { color: PLANT_COLOR() } },
    { type: 'bar', name: 'Fungal', x: donorKeys, y: donorKeys.map((k) => donorByKingdom[k].Fungal), marker: { color: FUNGAL_COLOR() } },
  ], { barmode: 'group' });

  const metalFreq = groupCount(entitiesMetal.rows, (r) => r.metal);
  const metalEntries = Object.entries(metalFreq).sort((a, b) => b[1] - a[1]);
  plot('c-metal', [{ type: 'bar', x: metalEntries.map((e) => e[0]), y: metalEntries.map((e) => e[1]), marker: { color: metalEntries.map((e) => colorFor(e[0])) } }],
    {}, { onClick: (d) => toggleMultiValue('metal', d.points[0].x) });

  const metalByKingdom = {};
  entitiesMetal.rows.forEach((r) => { (metalByKingdom[r.metal] ??= { Plant: 0, Fungal: 0 })[r.origin]++; });
  const metalKeys = Object.keys(metalByKingdom).sort((a, b) => (metalByKingdom[b].Plant + metalByKingdom[b].Fungal) - (metalByKingdom[a].Plant + metalByKingdom[a].Fungal));
  plot('c-metalking', [
    { type: 'bar', name: 'Plant', x: metalKeys, y: metalKeys.map((k) => metalByKingdom[k].Plant), marker: { color: PLANT_COLOR() } },
    { type: 'bar', name: 'Fungal', x: metalKeys, y: metalKeys.map((k) => metalByKingdom[k].Fungal), marker: { color: FUNGAL_COLOR() } },
  ], { barmode: 'group' });

  const phData = ['Plant', 'Fungal'].map((origin) => ({
    type: 'box', name: origin, y: rows.filter((r) => r.origin === origin && r.ph?.valid).map((r) => r.ph.mid),
    marker: { color: origin === 'Plant' ? PLANT_COLOR() : FUNGAL_COLOR() }, boxpoints: 'all', jitter: 0.4, pointpos: 0,
  }));
  plot('c-ph', phData, { yaxis: { title: 'pH' } });

  const tempData = ['Plant', 'Fungal'].map((origin) => ({
    type: 'box', name: origin, y: rows.filter((r) => r.origin === origin && r.temp?.valid).map((r) => r.temp.mid),
    marker: { color: origin === 'Plant' ? PLANT_COLOR() : FUNGAL_COLOR() }, boxpoints: 'all', jitter: 0.4, pointpos: 0,
  }));
  plot('c-temp', tempData, { yaxis: { title: '°C' } });

  const regioClass = (r) => {
    for (const t of r.regioTokens) {
      const c = t.trim();
      if (/^C/i.test(c)) return 'C-prenylation';
      if (/^O/i.test(c)) return 'O-prenylation';
    }
    return r.regioTokens.length ? 'Other / unspecified' : null;
  };
  const regioByOrigin = {};
  rows.forEach((r) => {
    const cls = regioClass(r);
    if (!cls) return;
    (regioByOrigin[cls] ??= { Plant: 0, Fungal: 0 })[r.origin]++;
  });
  const regioClasses = ['C-prenylation', 'O-prenylation', 'Other / unspecified'].filter((c) => regioByOrigin[c]);
  plot('c-regio', [
    { type: 'bar', name: 'Plant', x: regioClasses, y: regioClasses.map((c) => regioByOrigin[c].Plant), marker: { color: PLANT_COLOR() } },
    { type: 'bar', name: 'Fungal', x: regioClasses, y: regioClasses.map((c) => regioByOrigin[c].Fungal), marker: { color: FUNGAL_COLOR() } },
  ], { barmode: 'stack' }, { onClick: (d) => setFilter('search', d.points[0].x.replace(' / unspecified', '').replace('-prenylation', '')) });

  const phTempRows = rows.filter((r) => r.ph?.valid && r.temp?.valid);
  plot('c-phtemp', [{
    type: 'scatter', mode: 'markers', x: phTempRows.map((r) => r.ph.mid), y: phTempRows.map((r) => r.temp.mid),
    text: phTempRows.map((r) => r.enzyme),
    marker: { color: phTempRows.map((r) => r.origin === 'Plant' ? PLANT_COLOR() : FUNGAL_COLOR()), size: 9 },
  }], { xaxis: { title: 'Optimal pH' }, yaxis: { title: 'Optimal temperature (°C)' } });

  const completeness = groupCount(rows, (r) => r.dataCompleteness);
  plot('c-completeness', [{
    type: 'pie', labels: Object.keys(completeness), values: Object.values(completeness), hole: 0.55,
    marker: { colors: Object.keys(completeness).map((c) => c === 'complete' ? cssVar('--success') : c === 'partial' ? cssVar('--amber') : cssVar('--red')) },
    textinfo: 'label+percent',
  }], {}, { onClick: (d) => toggleMultiValue('completeness', d.points[0].label) });

  const donorBreadth = groupCount(rows, (r) => {
    const n = r.allAcceptedDonors.length;
    return n <= 1 ? '1 donor' : n === 2 ? '2 donors' : n === 3 ? '3 donors' : '4+ donors';
  });
  const breadthOrder = ['1 donor', '2 donors', '3 donors', '4+ donors'].filter((k) => donorBreadth[k]);
  plot('c-donorbreadth', [{ type: 'bar', x: breadthOrder, y: breadthOrder.map((k) => donorBreadth[k]), marker: { color: PLANT_COLOR() } }], {});
}
function groupCount(rows, fn) {
  const out = {};
  rows.forEach((r) => { const k = fn(r); out[k] = (out[k] || 0) + 1; });
  return out;
}

/* =========================================================================
   Data Cleaning & Parsing tab
   ========================================================================= */
async function renderCleaning() {
  const [audit, review] = await Promise.all([
    fetch('/api/dataset/audit-log').then((r) => r.json()),
    fetch('/api/dataset/manual-review').then((r) => r.json()),
  ]);
  document.querySelector('#auditTable tbody').innerHTML = audit.slice(0, 300).map((a) => `
    <tr><td>${escapeHtml(a.field || '')}</td><td>${a.sourceRow ?? ''}</td><td>${escapeHtml(a.enzyme || '')}</td>
    <td>${escapeHtml(truncate(a.raw || a.detail || '', 80))}</td><td>${escapeHtml(a.normalized || '')}</td><td>${escapeHtml(a.rule || '')}</td></tr>
  `).join('') || '<tr><td colspan="6">No normalization corrections were needed.</td></tr>';

  document.querySelector('#reviewTable tbody').innerHTML = review.map((r) => `
    <tr><td>${r.sno ?? ''}</td><td>${escapeHtml(r.enzyme || '')}</td><td>${r.sourceRow ?? ''}</td><td>${escapeHtml(r.reason || '')}</td></tr>
  `).join('') || '<tr><td colspan="4">No records flagged.</td></tr>';
}
function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

/* =========================================================================
   Bivariate tab
   ========================================================================= */
async function renderBivariate() {
  const bivar = await api('/api/analysis/bivariate');
  const useEntities = document.getElementById('f-entityCounts').checked;

  renderHeatmapKingdomAcceptor();
  renderYearStack();
  renderCountBar('chart-p-family-count', bivar.plant.family_enzymeCount, 'family');
  renderCountBar('chart-f-family-count', bivar.fungal.family_enzymeCount, 'family');
  renderCountBar('chart-p-genus-count', bivar.plant.genus_enzymeCount, 'genus', 30);
  renderCrossTab('chart-p-family-acc', bivar.plant.family_acceptorClass, 'family');
  renderCrossTab('chart-p-family-don', bivar.plant.family_donor, 'family');
  renderCrossTab('chart-p-genus-acc', bivar.plant.genus_acceptorClass, 'genus', 30);
  renderCrossTab('chart-p-genus-don', bivar.plant.genus_donor, 'genus', 30);
  renderCrossTab('chart-f-genus-acc', bivar.fungal.genus_acceptorClass, 'genus');
  renderCrossTab('chart-f-genus-don', bivar.fungal.genus_donor, 'genus');
  renderKmScatter();
  renderRegioChart();
}

async function renderRegioChart() {
  const data = await api('/api/analysis/regio');
  const classes = [...new Set(data.rows.map((r) => r.acceptorClass))].sort();
  const positions = [...new Set(data.rows.map((r) => r.regioPosition))].sort();
  const z = classes.map((c) => positions.map((p) => data.rows.find((r) => r.acceptorClass === c && r.regioPosition === p)?.count || 0));
  plot('chart-regio', [{
    type: 'heatmap', x: positions, y: classes, z,
    colorscale: [[0, cssVar('--panel-2')], [1, cssVar('--plant')]], showscale: true,
    hovertemplate: '%{y} · position %{x}<br>%{z} records<extra></extra>',
  }], { margin: { l: 170, r: 20, t: 10, b: 50 } },
  { onClick: (d) => { pushHistory(); filters.acceptorClass = [d.points[0].y]; filters.regioPosition = [d.points[0].x]; onFiltersChanged(); } });
}

async function renderHeatmapKingdomAcceptor() {
  const records = await api('/api/records', { pageSize: 500 });
  const rows = records.rows;
  const classes = [...new Set(rows.map((r) => r.acceptorClass).filter(Boolean))].sort();
  const origins = ['Plant', 'Fungal'];
  const z = origins.map((o) => classes.map((c) => rows.filter((r) => r.origin === o && r.acceptorClass === c).length));
  plot('chart-kxa', [{ type: 'heatmap', x: classes, y: origins, z, colorscale: [[0, cssVar('--panel-2')], [1, cssVar('--plant')]], showscale: true }],
    { margin: { l: 70, r: 20, t: 10, b: 120 } });
}

async function renderYearStack() {
  const records = await api('/api/records', { pageSize: 500 });
  const rows = records.rows;
  const years = [...new Set(rows.map((r) => r.year).filter(Boolean))].sort();
  const plantY = years.map((y) => rows.filter((r) => r.year === y && r.origin === 'Plant').length);
  const fungalY = years.map((y) => rows.filter((r) => r.year === y && r.origin === 'Fungal').length);
  plot('chart-yearstack', [
    { type: 'bar', name: 'Plant', x: years, y: plantY, marker: { color: PLANT_COLOR() } },
    { type: 'bar', name: 'Fungal', x: years, y: fungalY, marker: { color: FUNGAL_COLOR() } },
  ], { barmode: 'stack' });
}

function renderCountBar(elId, table, groupField, topN) {
  if (!table) return;
  let rows = table.rows;
  if (topN) rows = rows.slice(0, topN);
  plot(elId, [{ type: 'bar', orientation: 'h', y: rows.map((r) => r.group), x: rows.map((r) => r.count), marker: { color: rows.map((r) => colorFor(r.group)) } }],
    { margin: { l: 140, r: 20, t: 10, b: 40 } }, { onClick: (d) => toggleMultiValue(groupField, d.points[0].y) });
}

function renderCrossTab(elId, table, groupField, topN) {
  if (!table) return;
  const groups = [...new Set(table.rows.map((r) => r.group))];
  const limitedGroups = topN ? groups.slice(0, topN) : groups;
  const values = [...new Set(table.rows.map((r) => r.value))];
  const z = limitedGroups.map((g) => values.map((v) => table.rows.find((r) => r.group === g && r.value === v)?.count || 0));
  plot(elId, [{ type: 'heatmap', x: values, y: limitedGroups, z, colorscale: [[0, cssVar('--panel-2')], [1, cssVar('--fungal')]], showscale: true }],
    { margin: { l: 140, r: 20, t: 10, b: 100 } },
    { onClick: (d) => { toggleMultiValue(groupField, d.points[0].y); } });
}

async function renderKmScatter() {
  const records = await api('/api/records', { pageSize: 500 });
  const rows = records.rows.filter((r) => r.kmEntries.some((k) => k.role === 'donor') && r.kmEntries.some((k) => k.role === 'acceptor'));
  const donorVals = rows.map((r) => r.kmEntries.find((k) => k.role === 'donor').valueUM);
  const accVals = rows.map((r) => r.kmEntries.find((k) => k.role === 'acceptor').valueUM);
  plot('chart-km', [{
    type: 'scatter', mode: 'markers', x: donorVals, y: accVals, text: rows.map((r) => r.enzyme),
    marker: { color: rows.map((r) => r.origin === 'Plant' ? PLANT_COLOR() : FUNGAL_COLOR()), size: 9 },
  }], { xaxis: { type: 'log', title: 'Donor Km (µM)' }, yaxis: { type: 'log', title: 'Acceptor Km (µM)' } });
}

/* =========================================================================
   Statistical Analysis tab
   ========================================================================= */
async function renderStats() {
  const stats = await api('/api/analysis/stats');
  const fmtP = (p) => p == null ? '—' : (p < 0.0001 ? '<0.0001' : p.toFixed(4));
  document.getElementById('statsCards').innerHTML = `
    <div class="card stat-card"><div class="big">${fmt(stats.kingdomVsAcceptorClass.cramersV)}</div><div class="lbl">Cramér's V — Kingdom × Acceptor class</div><div class="sub">χ²=${fmt(stats.kingdomVsAcceptorClass.chi2)}, df=${stats.kingdomVsAcceptorClass.df}, p=${fmtP(stats.kingdomVsAcceptorClass.pValue)}, n=${stats.kingdomVsAcceptorClass.n}</div></div>
    <div class="card stat-card"><div class="big">${fmt(stats.kingdomVsDonor.cramersV)}</div><div class="lbl">Cramér's V — Kingdom × Donor</div><div class="sub">χ²=${fmt(stats.kingdomVsDonor.chi2)}, df=${stats.kingdomVsDonor.df}, p=${fmtP(stats.kingdomVsDonor.pValue)}, n=${stats.kingdomVsDonor.n} (parsed-entity level)</div></div>
    <div class="card stat-card"><div class="big">${fmt(stats.donorAcceptorKmCorrelation.r)}</div><div class="lbl">Pearson r — log Donor Km vs log Acceptor Km</div><div class="sub">n=${stats.donorAcceptorKmCorrelation.n}</div></div>
  `;
  document.getElementById('phSummary').innerHTML = kv({
    'Plant n / mean / median': `${stats.phByOrigin.Plant.n} / ${fmt(stats.phByOrigin.Plant.mean)} / ${fmt(stats.phByOrigin.Plant.median)}`,
    'Fungal n / mean / median': `${stats.phByOrigin.Fungal.n} / ${fmt(stats.phByOrigin.Fungal.mean)} / ${fmt(stats.phByOrigin.Fungal.median)}`,
  });
  document.getElementById('tempSummary').innerHTML = kv({
    'Plant n / mean / median': `${stats.tempByOrigin.Plant.n} / ${fmt(stats.tempByOrigin.Plant.mean)} / ${fmt(stats.tempByOrigin.Plant.median)}`,
    'Fungal n / mean / median': `${stats.tempByOrigin.Fungal.n} / ${fmt(stats.tempByOrigin.Fungal.mean)} / ${fmt(stats.tempByOrigin.Fungal.median)}`,
  });
  document.getElementById('missingSummary').innerHTML = kv({
    'Donor Km missing': `${stats.missingness.donorKm} / ${stats.missingness.total}`,
    'Acceptor Km missing': `${stats.missingness.acceptorKm} / ${stats.missingness.total}`,
    'pH unparseable/out-of-range': `${stats.missingness.ph} / ${stats.missingness.total}`,
    'Temperature unparseable/out-of-range': `${stats.missingness.temperature} / ${stats.missingness.total}`,
  });
}
function fmt(n) { return n == null || Number.isNaN(n) ? '—' : (Math.round(n * 1000) / 1000).toString(); }

/* =========================================================================
   Biological Insights tab
   ========================================================================= */
async function renderInsights() {
  const insights = await api('/api/analysis/insights');
  document.getElementById('insightsList').innerHTML = insights.map((i) => `
    <div class="insight-card${i.kingdom === 'fungal' ? ' fungal' : ''}">
      <div class="insight-tag">Computed observation</div>
      <p>${escapeHtml(i.text)}</p>
    </div>
  `).join('') || '<p class="sec-desc">No insights computable from the current filtered set.</p>';
}

/* =========================================================================
   Literature tab
   ========================================================================= */
async function renderLiterature() {
  const lit = await api('/api/analysis/literature');
  plot('c-litTrend', [{ type: 'bar', x: lit.trend.map((t) => t.year), y: lit.trend.map((t) => t.count), marker: { color: PLANT_COLOR() } }], {});
  document.querySelector('#literatureTable tbody').innerHTML = lit.items.map((it) => `
    <tr><td>${escapeHtml(it.enzyme || '')}</td><td><span class="badge ${it.origin === 'Plant' ? 'plant' : 'fungal'}">${it.origin || ''}</span></td>
    <td>${escapeHtml(it.author || '')}</td><td>${it.doi ? `<a href="${escapeAttr(it.doi)}" target="_blank" rel="noopener" style="color:var(--plant)">${escapeHtml(it.doi)}</a>` : '—'}</td></tr>
  `).join('');
}

/* =========================================================================
   Record Browser tab
   ========================================================================= */
function initBrowser() {
  document.getElementById('prevPage').addEventListener('click', () => { if (browserState.page > 1) { browserState.page--; renderBrowser(); } });
  document.getElementById('nextPage').addEventListener('click', () => {
    const maxPage = Math.ceil(browserState.total / browserState.pageSize) || 1;
    if (browserState.page < maxPage) { browserState.page++; renderBrowser(); }
  });
  document.querySelectorAll('#browserTable th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (browserState.sortField === field) browserState.sortDir = browserState.sortDir === 'asc' ? 'desc' : 'asc';
      else { browserState.sortField = field; browserState.sortDir = 'asc'; }
      renderBrowser();
    });
  });
}

async function renderBrowser() {
  const result = await api('/api/records', {
    page: browserState.page, pageSize: browserState.pageSize,
    sortField: browserState.sortField, sortDir: browserState.sortDir,
  });
  browserState.total = result.total;
  const maxPage = Math.ceil(result.total / browserState.pageSize) || 1;
  document.getElementById('browserCount').textContent = `${result.total} records`;
  document.getElementById('pageInfo').textContent = `Page ${browserState.page} / ${maxPage}`;

  const tbody = document.querySelector('#browserTable tbody');
  tbody.innerHTML = result.rows.map((r) => `
    <tr>
      <td>${r.id}</td><td>${escapeHtml(r.enzyme || '')}</td>
      <td><span class="badge ${r.origin === 'Plant' ? 'plant' : 'fungal'}">${r.origin || ''}</span></td>
      <td>${escapeHtml(r.family || '')}</td><td>${escapeHtml(r.acceptorClass || '')}</td>
      <td>${escapeHtml(r.primaryDonor || '')}</td><td>${r.year ?? ''}</td>
      <td>${escapeHtml(r.dataCompleteness || '')}</td>
      <td><button class="expand-btn" data-id="${r.id}">Details</button></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('.expand-btn').forEach((btn) => {
    btn.addEventListener('click', () => toggleDetailRow(btn));
  });
}

async function jumpToRecord(id) {
  switchTab('browser');
  browserState.sortField = 'id';
  browserState.sortDir = 'asc';
  browserState.page = Math.max(1, Math.ceil(id / browserState.pageSize));
  await renderBrowser();
  const btn = document.querySelector(`.expand-btn[data-id="${id}"]`);
  if (btn) { btn.scrollIntoView({ block: 'center' }); toggleDetailRow(btn); }
}

async function toggleDetailRow(btn) {
  const tr = btn.closest('tr');
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail-row')) { next.remove(); return; }
  const id = btn.dataset.id;
  const { record, raw } = await fetch(`/api/records/${id}`).then((r) => r.json());
  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  detail.innerHTML = `<td colspan="9"><div class="detail-grid">
    <div><div class="dk">Organism</div><div class="dv">${escapeHtml(record.organism || '')} ${record.commonName ? `(${escapeHtml(record.commonName)})` : ''}</div></div>
    <div><div class="dk">All accepted donors</div><div class="dv">${record.allAcceptedDonors.join(', ') || '—'}</div></div>
    <div><div class="dk">Accepted metals</div><div class="dv">${record.acceptedMetals.join(', ') || '—'}</div></div>
    <div><div class="dk">Regio tokens</div><div class="dv">${record.regioTokens.join(', ') || '—'}</div></div>
    <div><div class="dk">Km entries</div><div class="dv">${record.kmEntries.map((k) => `${k.label}: ${k.valueUM} µM (${k.role})`).join('; ') || '—'}</div></div>
    <div><div class="dk">pH / Temp</div><div class="dv">${record.ph.valid ? record.ph.mid : 'n/a'} / ${record.temp.valid ? record.temp.mid : 'n/a'} ${record.phTempSwapped ? '<span class="warn-pill">swap-corrected</span>' : ''}</div></div>
    <div><div class="dk">DOI</div><div class="dv">${record.doi ? `<a href="${escapeAttr(record.doi)}" target="_blank" rel="noopener" style="color:var(--plant)">${escapeHtml(record.doi)}</a>` : '—'}</div></div>
    <div><div class="dk">Source row</div><div class="dv">${record.sourceRow}</div></div>
    ${record.promiscuousDmapp ? '<div><div class="dk">Flag</div><div class="dv"><span class="warn-pill">Promiscuous DMAPP acceptor</span></div></div>' : ''}
    ${record.cofactorConditions ? `<div><div class="dk">Cofactor-dependent conditions (manual override)</div><div class="dv">${record.cofactorConditions.map((c) => `${c.metal} → ${c.acceptorSubstrate}: ${c.outcome}`).join('<br>')}</div></div>` : ''}
  </div></td>`;
  tr.after(detail);
}

/* =========================================================================
   Ask the Data (RAG)
   ========================================================================= */
function initAsk() {
  const input = document.getElementById('askInput');
  const btn = document.getElementById('askBtn');
  const run = () => askTheData(input.value.trim());
  btn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

async function askTheData(question) {
  if (!question) return;
  const statusEl = document.getElementById('askStatus');
  const retrievedEl = document.getElementById('askRetrieved');
  const btn = document.getElementById('askBtn');

  btn.disabled = true;
  statusEl.textContent = 'Searching…';
  retrievedEl.innerHTML = '';

  try {
    const resp = await fetch('/api/analysis/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, filters: filtersToParams(filters).toString() ? Object.fromEntries(filtersToParams(filters)) : {} }),
    });
    const data = await resp.json();
    if (!data.ok) {
      statusEl.textContent = '';
      retrievedEl.innerHTML = `<div class="ask-error">${escapeHtml(data.error || 'Something went wrong.')}</div>`;
      return;
    }
    statusEl.textContent = data.summary;
    if (data.records.length === 0) {
      retrievedEl.innerHTML = '<p class="cap">No matches. Try fewer or different keywords.</p>';
      return;
    }
    retrievedEl.innerHTML = `
      <table class="data-table">
        <thead><tr><th>S.No</th><th>Enzyme</th><th>Origin</th><th>Family</th><th>Acceptor class</th><th>Donor(s)</th><th>Year</th></tr></thead>
        <tbody>${data.records.map((r) => `
          <tr class="ask-result-row" data-id="${r.id}" style="cursor:pointer;">
            <td>${r.id}</td><td>${escapeHtml(r.enzyme || '')}</td>
            <td><span class="badge ${r.origin === 'Plant' ? 'plant' : 'fungal'}">${r.origin || ''}</span></td>
            <td>${escapeHtml(r.family || '')}</td><td>${escapeHtml(r.acceptorClass || '')}</td>
            <td>${escapeHtml((r.allAcceptedDonors || []).join(', '))}</td><td>${r.year ?? ''}</td>
          </tr>`).join('')}</tbody>
      </table>`;
    retrievedEl.querySelectorAll('.ask-result-row').forEach((el) => {
      el.addEventListener('click', async () => await jumpToRecord(Number(el.dataset.id)));
    });
  } catch (err) {
    statusEl.textContent = '';
    retrievedEl.innerHTML = `<div class="ask-error">Network error: ${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

/* =========================================================================
   Add Record
   ========================================================================= */
const ADD_RECORD_FIELDS = [
  'enzyme', 'origin', 'family', 'organism', 'acceptorClass', 'expressionHost',
  'acceptorAccepted', 'acceptorMedium', 'donorAccepted', 'donorMedium', 'metalAccepted', 'metalMedium',
  'product', 'regio', 'km', 'ph', 'temperature', 'year', 'author', 'doi',
];

function initAddRecordForm() {
  const form = document.getElementById('addRecordForm');
  const statusEl = document.getElementById('addRecordStatus');
  const submitBtn = document.getElementById('addRecordSubmit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    ADD_RECORD_FIELDS.forEach((f) => { body[f] = document.getElementById(`ar-${f}`).value.trim(); });

    submitBtn.disabled = true;
    statusEl.textContent = 'Adding record…';
    statusEl.style.color = 'var(--ink-soft)';

    try {
      const resp = await fetch('/api/records/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!data.ok) {
        statusEl.textContent = `${data.error}${data.details && data.details.length ? ' — ' + data.details.join('; ') : ''}`;
        statusEl.style.color = 'var(--red)';
        return;
      }
      statusEl.textContent = `Added as S.No ${data.newSno} — dataset now v${data.version}, ${data.recordCount} records.`;
      statusEl.style.color = 'var(--success)';
      form.reset();
      toast(`New record added (S.No ${data.newSno}).`);
    } catch (err) {
      statusEl.textContent = `Network error: ${err.message}`;
      statusEl.style.color = 'var(--red)';
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.getElementById('addRecordClear').addEventListener('click', () => {
    form.reset();
    statusEl.textContent = '';
  });
}

/* =========================================================================
   Utilities
   ========================================================================= */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

/* =========================================================================
   Boot
   ========================================================================= */
async function boot() {
  initUpload();
  initFilterControls();
  initTabs();
  initBrowser();
  initAsk();
  initAddRecordForm();
  renderChips();
  await loadStatus();
  connectWS();
  await refreshFilterOptions();
  await refreshAll();
}
boot();
