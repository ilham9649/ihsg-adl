// ──────────────────────────────────────────────
// Breadth & Momentum — how broad the market's trend is, over months.
// Everything here is derived in the browser from /api/ad (indicators.js);
// the reading period slices what the charts and the record show.
// ──────────────────────────────────────────────
import { BreadthChart } from './breadth-chart.js';
import { getJson, setFreshness, setFreshnessError, debounce, sparkline } from './shared.js';
import { PCT_SMOOTH_WINDOW, THRUST_RULES, attachAll } from './indicators.js';
import { HoverSync, linkBreadth } from './sync.js';

// ── Palette ──
const GOLD = '#a67a26', SLATE = '#3f5170', INK = '#1a1714';
const UP = '#2f6b4f', DOWN = '#b0392c';
const ZONE_UP = 'rgba(47,107,79,0.10)';
// Neutral band: marks a notable region that is neither bullish nor bearish.
const ZONE_FAINT = 'rgba(26,23,20,0.055)';


let allData = [];
let range = '252';  // the reading period: trailing sessions, 'ytd', or '0' for all
const panels = {};  // panel id → BreadthChart (built once, re-fed on every render)
const longDate = ds => new Date(ds + 'T00:00:00Z').toLocaleDateString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// ── Init ──
document.querySelectorAll('#period button').forEach(btn => btn.addEventListener('click', () => {
  range = btn.dataset.range;
  document.querySelectorAll('#period button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
  renderAll();
}));
document.getElementById('date-filter').addEventListener('input', debounce(() => { tableLimit = TABLE_PAGE; renderTable(getFilteredData()); }));
document.getElementById('record-more').addEventListener('click', () => { tableLimit = Infinity; renderTable(getFilteredData()); });
document.querySelectorAll('.figure-legend input[type=checkbox]').forEach(cb => cb.addEventListener('change', applyMaToggles));

// Show/hide breadth lines from the legend chips (unchecked → hidden key).
function applyMaToggles() {
  if (!panels.adline) return;
  const hidden = new Set();
  document.querySelectorAll('.figure-legend input[type=checkbox]')
    .forEach(cb => { if (!cb.checked) hidden.add(cb.dataset.key); });
  panels.adline.setHidden(hidden);
}

// ── Fetch ──
async function fetchData() {
  try {
    const data = await getJson('/api/ad');
    if (!data.success || !data.data?.length) { setFreshness(null); return; }
    allData = data.data;
    attachAll(allData);
    setFreshness(allData[allData.length - 1].date);
    renderAll();
  } catch (err) {
    console.error('Fetch error:', err);
    setFreshnessError(err.message);
  }
}

function getFilteredData() {
  if (range === 'ytd') {
    // Anchor YTD to the newest session's year, not the browser's local year.
    const latestYear = allData.length ? allData[allData.length - 1].date.slice(0, 4) : new Date().getFullYear();
    return allData.filter(d => d.date >= latestYear + '-01-01');
  }
  const n = parseInt(range, 10);
  return n ? allData.slice(-n) : allData;
}

function renderAll() {
  const data = getFilteredData();
  HoverSync.reset();
  renderCards();
  renderPanels(data);
  renderTable(data);
}

// ── Chart panels ──
// The page draws each legend once, in the figure head, so the canvases don't.
const PANEL_SPECS = {
  adline: {
    panel: 'series', field: 'pctAdvancingMA', rawField: 'pctAdvancing', legend: false,
    label: '% ADVANCING', tipLabel: `${PCT_SMOOTH_WINDOW}-day avg`, ref: 50, unit: '%',
    overlays: [
      { field: 'pctAdvancingMA100', color: GOLD, width: 1.4, label: '100-day' },
      { field: 'pctAdvancingMA200', color: SLATE, width: 1.6, label: '200-day' },
    ],
  },

  zbt: {
    panel: 'series', field: 'zbt', legend: false,
    label: 'ZWEIG THRUST', tipLabel: '10-day EMA',
    ref: 50, unit: '%', yMin: 20, yMax: 70, markField: 'idxThrust',
    zones: [
      { from: -Infinity, to: 40, fill: ZONE_FAINT },                 // oversold setup
      { from: THRUST_RULES.idxThrust, to: Infinity, fill: ZONE_UP }, // Jakarta rule
      { from: THRUST_RULES.thrust, to: Infinity, fill: ZONE_UP },    // Zweig's bar, stacks darker
    ],
  },

  // Neutral bands and plain lines: the reading is where the lines sit against
  // 20 and 80, and a red/green split at 50 on top of the bands only muddied it.
  stoch: {
    panel: 'series', field: 'stochK', legend: false, area: false, lineColor: INK,
    label: 'STOCHASTIC', tipLabel: '%K',
    ref: 50, yMin: 0, yMax: 100, tipAd: false,
    overlays: [{ field: 'stochD', color: SLATE, width: 1.6, label: '%D' }],
    zones: [
      { from: 0, to: 20, fill: ZONE_FAINT },
      { from: 80, to: 100, fill: ZONE_FAINT },
    ],
  },

  shinohara: {
    panel: 'series', field: 'shinSpread', legend: false,
    label: 'WEAK − STRONG', tipLabel: 'Weak − Strong',
    ref: 0, tipAd: false,
    zones: [{ from: 100, to: Infinity, fill: ZONE_UP }],
  },
};

function renderPanels(data) {
  for (const [id, spec] of Object.entries(PANEL_SPECS)) {
    const canvas = document.getElementById(id + '-chart');
    const tip = document.getElementById(id + '-tip');
    if (!canvas || !tip) continue;
    if (!panels[id]) panels[id] = new BreadthChart(canvas, tip, spec);
    panels[id].setData(data);
    linkBreadth(panels[id]);
  }
  applyMaToggles();
}


// ── Headline and tiles ──
function ordinal(n) {
  const t = n % 100;
  const suffix = (t >= 11 && t <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return n + suffix;
}

function renderCards() {
  if (!allData.length) return;
  const at = allData.length - 1;
  const latest = allData[at];
  const pa = latest.pctAdvancing;
  document.getElementById('hero-date').textContent = longDate(latest.date);
  if (pa != null) {
    const broad = pa >= 50;
    const heroNum = document.getElementById('pct-advancing');
    heroNum.textContent = pa.toFixed(1) + '%';
    heroNum.style.color = broad ? UP : DOWN;
    const verdict = document.getElementById('pct-verdict');
    verdict.textContent = broad ? 'A broad advance' : 'A narrowing market';
    verdict.style.color = broad ? UP : DOWN;
    const hist = allData.map(d => d.pctAdvancing).filter(v => v != null);
    document.getElementById('pct-percentile').textContent = ordinal(Math.round(hist.filter(v => v < pa).length / hist.length * 100));
  }
  if (latest.pctAdvancingMA != null) document.getElementById('pct-advancing-ma').textContent = latest.pctAdvancingMA.toFixed(1) + '%';

  // Fig. III figures — computed, never hardcoded.
  const peak = Math.max(...allData.map(d => d.zbt).filter(v => v != null));
  document.getElementById('zbt-record').textContent = peak.toFixed(1) + '%';
  const hits = allData.filter(d => d.thrust);
  const years = [...new Set(hits.map(d => d.date.slice(0, 4)))].join(' and ');
  document.getElementById('zbt-count').textContent = hits.length === 0 ? 'not once'
    : hits.length === 1 ? `once, in ${years}`
    : hits.length === 2 ? `twice, both in ${years}`
    : `${hits.length} times, in ${years}`;
  // Jakarta rule: count episodes (≥63 sessions apart) and compare the IHSG's
  // six-month return after each with an ordinary day's.
  const H = 126;
  const fwd = i => i + H < allData.length && allData[i].ihsg && allData[i + H].ihsg ? allData[i + H].ihsg / allData[i].ihsg - 1 : null;
  const mean = v => v.reduce((a, b) => a + b, 0) / v.length;
  const idx = allData.map((d, i) => d.idxThrust ? i : -1).filter(i => i >= 0);
  const episodes = idx.filter((i, k) => k === 0 || i - idx[k - 1] > 63);
  const after = episodes.map(fwd).filter(v => v != null);
  const base = allData.map((_, i) => fwd(i)).filter(v => v != null);
  const pct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
  document.getElementById('idx-count').textContent = `${episodes.length} episodes`;
  document.getElementById('idx-after').textContent = after.length ? pct(mean(after)) : '—';
  document.getElementById('idx-base').textContent = base.length ? pct(mean(base)) : '—';

  document.getElementById('universe-count').textContent = latest.advances + latest.declines + latest.unchanged;

  // Tiles: the latest value, and its last 30 sessions as a sparkline.
  const recent = allData.slice(Math.max(0, at - 29), at + 1);
  const tiles = [
    ['advances', latest.advances, null, d => d.advances, 'up'],
    ['declines', latest.declines, null, d => d.declines, 'down'],
    ['unchanged', latest.unchanged, null, d => d.unchanged, ''],
    ['ratio', latest.ratio.toFixed(2), 1, d => d.ratio, latest.ratio >= 1 ? 'up' : 'down'],
    ['spread', (latest.spread >= 0 ? '+' : '') + latest.spread, 0, d => d.spread, latest.spread >= 0 ? 'up' : 'down'],
    ['mcclellan', (latest.mcClellan >= 0 ? '+' : '') + latest.mcClellan.toFixed(1), 0, d => d.mcClellan, latest.mcClellan >= 0 ? 'up' : 'down'],
  ];
  for (const [id, text, ref, get, tone] of tiles) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = 'tile-value ' + tone;
    sparkline(document.getElementById(id + '-spark'), recent.map(get), { ref });
  }
}


// ── The daily record ──
const num = (v, dp = 1) => v == null ? '—' : v.toFixed(dp);
const signed = (v, dp = 0) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(dp);
const above = (ref) => (v) => v == null ? null : (v >= ref ? 'td-positive' : 'td-negative');

// Columns in groups, so sixteen of them read as four questions.
const TABLE_GROUPS = [
  { head: '', cols: [
    { key: 'date', head: 'Date', desc: 'Trading session', get: d => d.date, num: false },
    { key: 'ihsg', head: 'IHSG', desc: 'Index close', get: d => d.ihsg == null ? '—' : Math.round(d.ihsg).toLocaleString('en-US') },
  ] },
  { head: 'The count', cols: [
    { key: 'advances', head: 'Adv', desc: 'Companies that closed higher', get: d => d.advances, cls: () => 'td-positive' },
    { key: 'declines', head: 'Dec', desc: 'Companies that closed lower', get: d => d.declines, cls: () => 'td-negative' },
    { key: 'unchanged', head: 'Unch', desc: 'Closed flat, or did not trade', get: d => d.unchanged },
    { key: 'spread', head: 'Spread', desc: 'Advances minus declines', get: d => signed(d.spread), cls: d => above(0)(d.spread) },
    { key: 'ratio', head: 'Ratio', desc: 'Advances per decline; 1.00 is even', get: d => num(d.ratio, 2), cls: d => above(1)(d.ratio) },
  ] },
  { head: 'Breadth', cols: [
    { key: 'pctAdvancing', head: '% Adv', desc: 'Share of trading companies that rose; 50% is neutral', get: d => d.pctAdvancing == null ? '—' : num(d.pctAdvancing) + '%', cls: d => above(50)(d.pctAdvancing) },
    { key: 'pctAdvancingMA', head: '20d', desc: '20-day average of % Advancing', get: d => num(d.pctAdvancingMA), cls: d => above(50)(d.pctAdvancingMA) },
    { key: 'pctAdvancingMA100', head: '100d', desc: '100-day average of % Advancing', get: d => num(d.pctAdvancingMA100), cls: d => above(50)(d.pctAdvancingMA100) },
    { key: 'pctAdvancingMA200', head: '200d', desc: '200-day average of % Advancing', get: d => num(d.pctAdvancingMA200), cls: d => above(50)(d.pctAdvancingMA200) },
    { key: 'zbt', head: 'ZBT', desc: 'Zweig Breadth Thrust: 10-day EMA of % Advancing', get: d => num(d.zbt), cls: d => above(50)(d.zbt) },
    { key: 'mcClellan', head: 'McClellan', desc: '19 less 39-day EMA of the spread; 0 is neutral', get: d => signed(d.mcClellan, 1), cls: d => above(0)(d.mcClellan) },
  ] },
  { head: 'Momentum (weekly)', cols: [
    { key: 'stochK', head: '%K', desc: 'Weekly stochastic (15,3,3)', get: d => num(d.stochK), cls: d => above(50)(d.stochK) },
    { key: 'stochD', head: '%D', desc: 'Three-week average of %K', get: d => num(d.stochD), cls: d => above(50)(d.stochD) },
    { key: 'shinSpread', head: 'W−S', desc: 'Shinohara Weak minus Strong; above 100 extremely oversold', get: d => num(d.shinSpread), cls: d => above(0)(d.shinSpread) },
  ] },
];
const TABLE_COLS = TABLE_GROUPS.flatMap((g, gi) => g.cols.map((c, ci) => ({ ...c, groupStart: gi > 0 && ci === 0 })));

const TABLE_PAGE = 50;
let tableLimit = TABLE_PAGE;
let sortKey = 'date';
let sortDir = -1; // most recent session first

function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // blanks last
    return x > y ? sortDir : x < y ? -sortDir : 0;
  });
}

function renderTableHead() {
  const thead = document.querySelector('#data-table thead');
  if (thead.children.length) return;
  const groups = document.createElement('tr');
  groups.className = 'groups';
  for (const g of TABLE_GROUPS) {
    const th = document.createElement('th');
    th.colSpan = g.cols.length;
    th.textContent = g.head;
    groups.appendChild(th);
  }
  const heads = document.createElement('tr');
  for (const c of TABLE_COLS) {
    const th = document.createElement('th');
    if (c.num !== false) th.classList.add('num');
    if (c.groupStart) th.classList.add('group-start');
    th.scope = 'col';
    th.title = `${c.desc} — click to sort`;
    th.dataset.key = c.key;
    th.tabIndex = 0;
    th.textContent = c.head;
    const sort = () => {
      sortDir = sortKey === c.key ? -sortDir : -1;
      sortKey = c.key;
      renderTable(getFilteredData());
    };
    th.addEventListener('click', sort);
    th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } });
    heads.appendChild(th);
  }
  thead.append(groups, heads);
}

function renderTable(data) {
  renderTableHead();
  const query = document.getElementById('date-filter').value.trim();
  // A search reaches the whole record: the period only slices backwards from today.
  const rows = sortRows(query ? allData.filter(d => d.date.includes(query)) : data);
  const shown = rows.slice(0, tableLimit);
  const frag = document.createDocumentFragment();
  for (const d of shown) {
    const tr = document.createElement('tr');
    for (const c of TABLE_COLS) {
      const td = document.createElement('td');
      const cls = c.cls ? c.cls(d) : null;
      if (cls) td.className = cls;
      if (c.num !== false) td.classList.add('num');
      if (c.groupStart) td.classList.add('group-start');
      td.textContent = c.get(d);
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  document.querySelector('#data-table tbody').replaceChildren(frag);
  document.querySelectorAll('#data-table thead th[data-key]').forEach(th => {
    const on = th.dataset.key === sortKey;
    th.dataset.sorted = on ? (sortDir === 1 ? 'asc' : 'desc') : '';
    th.setAttribute('aria-sort', on ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
  });
  const more = document.getElementById('record-more');
  more.hidden = shown.length >= rows.length;
  more.textContent = `Show all ${rows.length.toLocaleString('en-US')} sessions`;
  document.getElementById('record-count').textContent = query
    ? `${rows.length} of ${allData.length.toLocaleString('en-US')} sessions match`
    : `${shown.length.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')} sessions`;
}


// ── Start ──
fetchData();
