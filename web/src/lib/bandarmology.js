// ──────────────────────────────────────────────
// Bandarmology — broker-flow readings for the most-traded stocks.
// The openclaw server job computes everything (backend/scrapers/bandarmology.js,
// jobs/bandarmology/); this page lists the board and charts one stock.
// ──────────────────────────────────────────────
import { BreadthChart } from './breadth-chart.js';
import { getJson, setFreshness, setFreshnessError, longDate, debounce } from './shared.js';
import { dataTable } from './table.js';

const UP = '#2f6b4f', DOWN = '#b0392c', GOLD = '#a67a26', SLATE = '#3f5170', INK = '#1a1714';

let rows = [];
let band = 'all';
let current = null;
const seriesCache = new Map();

const num = (v, d = 0) => v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sigma = v => v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + 'σ';
const signedPct = v => v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '%';
const tone = v => v == null ? null : (v >= 0 ? 'td-positive' : 'td-negative');
// Rupiah, compact: 1.2T, 340B, 12M.
const rp = v => {
  if (v == null) return '—';
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e12) return s + (a / 1e12).toFixed(1) + 'T';
  if (a >= 1e9) return s + (a / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return s + (a / 1e6).toFixed(0) + 'M';
  return s + Math.round(a).toLocaleString('en-US');
};

const isAcc = r => r.lpm20z != null && r.lpm20z >= 1;
const isDist = r => r.lpm20z != null && r.lpm20z <= -1;

// ── Headline ──
function renderLede(asOf) {
  const count = f => rows.filter(f).length;
  document.getElementById('universe-count').textContent = rows.length;
  document.getElementById('m-universe').textContent = rows.length;
  document.getElementById('hero-date').textContent = asOf ? longDate(asOf) : '—';
  const acc = count(isAcc), dist = count(isDist), div = count(r => r.divergence);
  const rated = count(r => r.lpm20z != null);
  document.getElementById('acc-count').textContent = acc;
  document.getElementById('acc-verdict').textContent = rated
    ? `of ${rated} stocks with enough history saw big tickets lean to the buy side over 20 sessions`
    : 'Not enough history yet for 20-session readings — they appear after ~60 sessions';
  document.getElementById('dist-count').textContent = dist;
  document.getElementById('div-count').textContent = div;
  document.getElementById('t-acc').textContent = acc;
  document.getElementById('t-dist').textContent = dist;
  document.getElementById('t-div').textContent = div;
  const flow = rows.reduce((t, r) => t + (r.flow20 || 0), 0);
  const flowEl = document.getElementById('t-flow');
  flowEl.textContent = rows.some(r => r.flow20 != null) ? rp(flow) : '—';
  flowEl.className = 'tile-value ' + (flow >= 0 ? 'up' : 'down');
  document.getElementById('t-churn').textContent = count(r => r.vrz != null && r.vrz >= 1);
  document.getElementById('t-int').textContent = count(r => r.intensityZ != null && Math.abs(r.intensityZ) >= 2);
}

// ── Board ──
const board = dataTable({
  table: document.getElementById('data-table'),
  sort: { key: 'lpm20z', dir: -1 },
  cols: [
    { key: 'code', head: 'Code', desc: 'IDX ticker', get: r => r.code, num: false },
    { key: 'close', head: 'Close', desc: 'Latest close, rupiah', get: r => num(r.close) },
    { key: 'ret20', head: '20d', desc: 'Price change over 20 sessions', get: r => signedPct(r.ret20), cls: r => tone(r.ret20) },
    { key: 'lpm20z', head: 'LPM 20d', desc: '20-session LPM change in units of the stock\'s own daily LPM volatility', get: r => sigma(r.lpm20z), cls: r => tone(r.lpm20z) },
    { key: 'flow20', head: 'Foreign 20d', desc: 'Net foreign buying over 20 sessions, rupiah', get: r => rp(r.flow20), cls: r => tone(r.flow20) },
    { key: 'flow20z', head: 'Foreign σ', desc: 'The same, in units of the stock\'s own daily foreign-flow volatility', get: r => sigma(r.flow20z), cls: r => tone(r.flow20z) },
    { key: 'vr', head: 'Rotation', desc: 'Volume over net volume that changed hands between brokers, latest session', get: r => num(r.vr, 2) },
    { key: 'vrz', head: 'Rotation σ', desc: 'Latest rotation against the stock\'s own history', get: r => sigma(r.vrz) },
    { key: 'intensityZ', head: 'Intensity σ', desc: 'Latest intensity (log) against the stock\'s own history', get: r => sigma(r.intensityZ) },
    { key: 'valueMed20', head: 'Value', desc: 'Median daily traded value over 20 sessions, rupiah', get: r => rp(r.valueMed20) },
  ],
  count: document.getElementById('row-count'), more: document.getElementById('row-more'), noun: ['stock', 'stocks'],
});

function applyFilters() {
  const q = document.getElementById('search-input').value.trim().toUpperCase();
  board.render(rows.filter(r => {
    if (band === 'acc' && !isAcc(r)) return false;
    if (band === 'dist' && !isDist(r)) return false;
    if (band === 'div' && !r.divergence) return false;
    return !q || r.code.includes(q);
  }), { reset: true });
  markSelected();
}

function markSelected() {
  for (const tr of document.querySelectorAll('#data-table tbody tr')) {
    tr.setAttribute('aria-selected', String(tr.cells[0]?.textContent === current));
  }
}

// ── One stock ──
const charts = {};
const SPECS = {
  price: { panel: 'series', field: 'close', legend: false, area: false, lineColor: INK, tipLabel: 'Close', tipAd: false },
  lpm: { panel: 'series', field: 'lpm', legend: false, area: false, lineColor: GOLD, tipLabel: 'LPM', tipAd: false },
  lpmday: { panel: 'series', field: 'lpmChange', legend: false, ref: 0, tipLabel: 'Day', tipAd: false },
  flow: { panel: 'series', field: 'flow', legend: false, ref: 0, tipLabel: 'Foreign', tipAd: false },
  vr: { panel: 'series', field: 'vr', legend: false, area: false, lineColor: SLATE, tipLabel: 'Rotation', decimals: 2, tipAd: false },
  int: { panel: 'series', field: 'intensity', legend: false, area: false, lineColor: SLATE, tipLabel: 'log₁₀', decimals: 1, tipAd: false },
};

async function loadStock(code) {
  current = code;
  markSelected();
  document.getElementById('stock-select').value = code;
  document.getElementById('stock-title').textContent = code;
  const r = rows.find(x => x.code === code);
  document.getElementById('stock-dek').textContent = r
    ? `Close ${num(r.close)} · 20 sessions: price ${signedPct(r.ret20)}, LPM ${sigma(r.lpm20z)}, foreign ${rp(r.flow20)}` + (r.divergence ? ' · quiet accumulation' : '')
    : '';
  let series = seriesCache.get(code);
  if (!series) {
    const payload = await getJson(`/api/bandarmology/${code}`);
    if (!payload.success) { document.getElementById('stock-dek').textContent = `No series stored for ${code}.`; return; }
    // [date, close, lpm, lpmChange, flow, rotation, intensity] — see jobs/bandarmology/build.mjs
    series = payload.data.map(([date, close, lpm, lpmChange, flow, vr, intensity]) => ({
      date, close, lpm, lpmChange, flow, vr, intensity: intensity > 0 ? Math.log10(intensity) : null,
    }));
    seriesCache.set(code, series);
  }
  if (current !== code) return; // a newer pick arrived while this one loaded
  const list = [];
  for (const [id, spec] of Object.entries(SPECS)) {
    if (!charts[id]) charts[id] = new BreadthChart(document.getElementById(id + '-chart'), document.getElementById(id + '-tip'), spec);
    charts[id].setData(series);
    list.push(charts[id]);
  }
  // One date axis across the six panels: hovering any marks them all.
  for (const c of list) {
    c.onHover = i => list.forEach(o => o !== c && o.setHover(i));
    c.onLeave = () => list.forEach(o => o !== c && o.clearHover());
  }
}

// ── Fetch ──
async function fetchData() {
  try {
    const payload = await getJson('/api/bandarmology');
    if (!payload.success || !payload.data?.length) {
      setFreshness(null);
      document.getElementById('acc-verdict').textContent = 'No broker-flow reading stored yet.';
      return;
    }
    rows = payload.data;
    setFreshness(payload.asOf);
    renderLede(payload.asOf);
    const select = document.getElementById('stock-select');
    select.replaceChildren(...rows.map(r => r.code).sort().map(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; return o; }));
    applyFilters();
    const first = [...rows].sort((a, b) => (b.lpm20z ?? -99) - (a.lpm20z ?? -99))[0];
    const fromHash = location.hash.slice(1).toUpperCase();
    loadStock(rows.some(r => r.code === fromHash) ? fromHash : first.code);
  } catch (err) {
    console.error('Failed to load bandarmology:', err);
    setFreshnessError(err.message);
  }
}

// ── Controls ──
document.querySelectorAll('#band button').forEach(btn => btn.addEventListener('click', () => {
  band = btn.dataset.band;
  document.querySelectorAll('#band button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
  applyFilters();
}));
document.getElementById('search-input').addEventListener('input', debounce(applyFilters, 150));
document.getElementById('data-table').addEventListener('click', e => {
  const tr = e.target.closest('tbody tr');
  const code = tr?.cells[0]?.textContent;
  if (code && rows.some(r => r.code === code)) { history.replaceState(null, '', '#' + code); loadStock(code); }
});
document.getElementById('stock-select').addEventListener('change', e => {
  history.replaceState(null, '', '#' + e.target.value);
  loadStock(e.target.value);
});

fetchData();
