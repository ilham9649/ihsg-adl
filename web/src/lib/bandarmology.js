// ──────────────────────────────────────────────
// Bandarmology — a stock list beside one stock's charts.
// The openclaw server job computes everything (backend/scrapers/bandarmology.js,
// jobs/bandarmology/); this page lists the stocks and charts the one picked.
// Readings are put in words here: lpm20z → "Strong buying" … "Strong selling".
// ──────────────────────────────────────────────
import { BreadthChart } from './breadth-chart.js';
import { getJson, setFreshness, setFreshnessError, debounce } from './shared.js';

const INK = '#1a1714', GOLD = '#a67a26', SLATE = '#3f5170';

let rows = [];
let band = 'all';
let sortKey = 'lpm20z', sortDir = -1;
let current = null;
let shown = [];
const seriesCache = new Map();
const $ = id => document.getElementById(id);

// ── Words and numbers ──
const pct = v => v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '%';
const rp = v => {
  if (v == null) return '—';
  const a = Math.abs(v), s = v < 0 ? '−' : '+';
  if (a >= 1e12) return s + (a / 1e12).toFixed(1) + 'T';
  if (a >= 1e9) return s + (a / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return s + (a / 1e6).toFixed(0) + 'M';
  return s + Math.round(a).toLocaleString('en-US');
};
const rpPlain = v => rp(v).replace(/^[+−]/, '');
const price = v => v == null ? '—' : Number(v).toLocaleString('en-US');

const isBuy = r => r.lpm20z != null && r.lpm20z >= 1;
const isSell = r => r.lpm20z != null && r.lpm20z <= -1;
function pressureWord(z) {
  if (z == null) return 'Too new';
  if (z >= 2) return 'Strong buying';
  if (z >= 1) return 'Buying';
  if (z <= -2) return 'Strong selling';
  if (z <= -1) return 'Selling';
  return 'Neutral';
}
const tone = v => v == null ? 'bm-quiet' : v >= 0 ? 'bm-pos' : 'bm-neg';

function readout(r) {
  const z = r.lpm20z;
  let lead;
  if (z == null) lead = `${r.code} is too new for a 20-session reading.`;
  else if (z >= 2) lead = `Over the last 20 sessions, large orders in ${r.code} leaned strongly to buying — more than twice the usual swing for this stock.`;
  else if (z >= 1) lead = `Over the last 20 sessions, large orders in ${r.code} leaned to buying, more than is usual for this stock.`;
  else if (z <= -2) lead = `Over the last 20 sessions, large orders in ${r.code} leaned strongly to selling — more than twice the usual swing for this stock.`;
  else if (z <= -1) lead = `Over the last 20 sessions, large orders in ${r.code} leaned to selling, more than is usual for this stock.`;
  else lead = `Over the last 20 sessions, large orders in ${r.code} were roughly balanced between buying and selling.`;
  const parts = [];
  if (r.ret20 != null) parts.push(`the price ${r.ret20 >= 0 ? 'rose' : 'fell'} ${Math.abs(r.ret20 * 100).toFixed(1)}%`);
  if (r.flow20 != null) parts.push(`foreign investors were net ${r.flow20 >= 0 ? 'buyers' : 'sellers'} of Rp ${rpPlain(r.flow20)}`);
  const tail = parts.length ? ' Over the same stretch ' + parts.join(' and ') + '.' : '';
  return lead + tail + (r.divergence ? ' Big buyers stepped in while the price was not rising.' : '');
}

// ── Filter counts ──
function renderCounts() {
  const counts = { all: rows.length, buy: rows.filter(isBuy).length, sell: rows.filter(isSell).length, weak: rows.filter(r => r.divergence).length };
  document.querySelectorAll('[data-count]').forEach(s => { s.textContent = counts[s.dataset.count]; });
}

// ── The list ──
function pressureCell(z) {
  const wrap = document.createElement('span');
  wrap.className = 'bm-pressure';
  const bar = document.createElement('span');
  bar.className = 'bm-bar';
  bar.setAttribute('aria-hidden', 'true');
  if (z != null) {
    const w = Math.min(Math.abs(z), 3) / 3 * 50;
    const i = document.createElement('i');
    i.style.width = w + '%';
    i.style.left = z >= 0 ? '50%' : (50 - w) + '%';
    i.style.background = Math.abs(z) < 1 ? 'var(--ink-faint)' : z > 0 ? 'var(--up)' : 'var(--down)';
    bar.appendChild(i);
  }
  const word = document.createElement('span');
  word.className = 'bm-word' + (z != null && Math.abs(z) >= 2 ? ' strong' : '');
  word.textContent = pressureWord(z);
  wrap.append(bar, word);
  return wrap;
}

function renderList() {
  const q = $('search-input').value.trim().toUpperCase();
  shown = rows.filter(r => {
    if (band === 'buy' && !isBuy(r)) return false;
    if (band === 'sell' && !isSell(r)) return false;
    if (band === 'weak' && !r.divergence) return false;
    return !q || r.code.includes(q);
  }).sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return x > y ? sortDir : x < y ? -sortDir : 0;
  });
  const frag = document.createDocumentFragment();
  for (const r of shown) {
    const li = document.createElement('li');
    li.className = 'bm-row';
    li.role = 'option';
    li.dataset.code = r.code;
    li.setAttribute('aria-selected', String(r.code === current));
    li.setAttribute('aria-label', `${r.code}: price ${pct(r.ret20)}, big money ${pressureWord(r.lpm20z)}, foreign ${rp(r.flow20)}`);
    const cell = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
    li.append(
      cell('bm-code', r.code),
      cell('bm-ret ' + tone(r.ret20), pct(r.ret20)),
      pressureCell(r.lpm20z),
      cell('bm-flow ' + tone(r.flow20), rp(r.flow20)),
    );
    frag.appendChild(li);
  }
  $('bm-rows').replaceChildren(frag);
  $('bm-empty').hidden = shown.length > 0;
  document.querySelectorAll('.bm-list-head button').forEach(b => {
    const on = b.dataset.sort === sortKey;
    b.setAttribute('aria-pressed', String(on));
    b.dataset.dir = sortDir === 1 ? 'asc' : 'desc';
  });
}

function markSelected() {
  for (const li of $('bm-rows').children) li.setAttribute('aria-selected', String(li.dataset.code === current));
}

// ── One stock ──
const charts = {};
const SPECS = {
  price: { field: 'close', area: false, lineColor: INK, tipColor: 'inherit', tipLabel: 'Close' },
  lpm: { field: 'lpm', area: false, lineColor: GOLD, tipColor: 'inherit', tipLabel: 'Pressure' },
  flow: { field: 'flow', ref: 0, tipLabel: 'Foreign' },
  lpmday: { field: 'lpmChange', ref: 0, tipLabel: 'Day' },
  vr: { field: 'vr', area: false, lineColor: SLATE, tipColor: 'inherit', tipLabel: 'Churn', decimals: 2 },
  int: { field: 'intensity', area: false, lineColor: SLATE, tipColor: 'inherit', tipLabel: 'Level', decimals: 1 },
};

function renderFacts(r) {
  const facts = [
    ['Big money, 20 sessions', r ? pressureWord(r.lpm20z) : '—', r ? tone(r.lpm20z == null || Math.abs(r.lpm20z) < 1 ? null : r.lpm20z) : ''],
    ['Foreign, 20 sessions', r?.flow20 != null ? rp(r.flow20).replace(/^([+−])/, '$1Rp ') : '—', r ? tone(r.flow20) : ''],
    ['Traded per day', r?.valueMed20 != null ? 'Rp ' + rpPlain(r.valueMed20) : '—', ''],
  ];
  $('stock-facts').replaceChildren(...facts.map(([k, v, cls]) => {
    const d = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v; if (cls && cls !== 'bm-quiet') dd.className = cls;
    d.append(dt, dd);
    return d;
  }));
}

async function loadStock(code, { scroll = false } = {}) {
  current = code;
  markSelected();
  const r = rows.find(x => x.code === code);
  $('stock-title').textContent = code;
  const head = $('stock-price');
  head.replaceChildren();
  if (r) {
    const close = document.createElement('b'); close.textContent = 'Rp ' + price(r.close);
    const move = document.createElement('span');
    move.className = tone(r.ret20);
    move.textContent = r.ret20 == null ? '' : `${r.ret20 >= 0 ? 'up' : 'down'} ${Math.abs(r.ret20 * 100).toFixed(1)}% in 20 sessions`;
    head.append(close, ' ', move);
  }
  $('stock-read').textContent = r ? readout(r) : '';
  renderFacts(r);
  if (scroll && matchMedia('(max-width: 960px)').matches) $('bm-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  let series = seriesCache.get(code);
  if (!series) {
    const payload = await getJson(`/api/bandarmology/${code}`);
    if (!payload.success) { $('stock-read').textContent = `No history stored for ${code} yet.`; return; }
    // [date, close, lpm, lpmChange, flow, rotation, intensity] — see jobs/bandarmology/build.mjs
    series = payload.data.map(([date, close, lpm, lpmChange, flow, vr, intensity]) => ({
      date, close, lpm, lpmChange, flow, vr, intensity: intensity > 0 ? Math.log10(intensity) : null,
    }));
    seriesCache.set(code, series);
  }
  if (current !== code) return; // a newer pick arrived while this one loaded
  const list = [];
  for (const [id, spec] of Object.entries(SPECS)) {
    if (!charts[id]) charts[id] = new BreadthChart($(id + '-chart'), $(id + '-tip'), { panel: 'series', legend: false, tipAd: false, ...spec });
    charts[id].setData(series);
    list.push(charts[id]);
  }
  // One date axis down the column: hovering any chart marks them all.
  for (const c of list) {
    c.onHover = i => list.forEach(o => o !== c && o.setHover(i));
    c.onLeave = () => list.forEach(o => o !== c && o.clearHover());
  }
}

function pick(code, opts) {
  if (!code || !rows.some(r => r.code === code)) return;
  history.replaceState(null, '', '#' + code);
  loadStock(code, opts);
}

// ── Fetch ──
async function fetchData() {
  try {
    const payload = await getJson('/api/bandarmology');
    if (!payload.success || !payload.data?.length) {
      setFreshness(null);
      $('stock-read').textContent = 'No broker-summary reading is stored yet. The first one appears after the evening update.';
      return;
    }
    rows = payload.data;
    setFreshness(payload.asOf);
    renderCounts();
    renderList();
    const fromHash = location.hash.slice(1).toUpperCase();
    loadStock(rows.some(r => r.code === fromHash) ? fromHash : shown[0]?.code ?? rows[0].code);
  } catch (err) {
    console.error('Failed to load bandarmology:', err);
    setFreshnessError(err.message);
    $('stock-read').textContent = 'The readings could not be loaded. Reload the page to try again.';
  }
}

// ── Controls ──
document.querySelectorAll('#band button').forEach(btn => btn.addEventListener('click', () => {
  band = btn.dataset.band;
  document.querySelectorAll('#band button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
  renderList();
}));
document.querySelectorAll('.bm-list-head button').forEach(btn => btn.addEventListener('click', () => {
  const key = btn.dataset.sort;
  // A new column starts with the biggest (or A first, for the ticker); a second click flips it.
  sortDir = sortKey === key ? -sortDir : (key === 'code' ? 1 : -1);
  sortKey = key;
  renderList();
}));
$('search-input').addEventListener('input', debounce(renderList, 150));
$('bm-rows').addEventListener('click', e => pick(e.target.closest('.bm-row')?.dataset.code, { scroll: true }));
$('bm-rows').addEventListener('keydown', e => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !shown.length) return;
  e.preventDefault();
  const at = shown.findIndex(r => r.code === current);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? shown.length - 1
    : Math.max(0, Math.min(shown.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
  pick(shown[next].code);
  $('bm-rows').querySelector(`[data-code="${shown[next].code}"]`)?.scrollIntoView({ block: 'nearest' });
});

// A #CODE link followed while the page is open.
window.addEventListener('hashchange', () => {
  const code = location.hash.slice(1).toUpperCase();
  if (code !== current && rows.some(r => r.code === code)) loadStock(code);
});

fetchData();
