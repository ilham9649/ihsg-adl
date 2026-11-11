// ──────────────────────────────────────────────
// Trend Line — proximity to each stock's own 200-week average.
// The backend computes the readings (scrapers/ma200w.js); this page charts
// the daily trend, draws the distribution, and lists the stocks.
// ──────────────────────────────────────────────
import { BreadthChart } from './breadth-chart.js';
import { getJson, setFreshness, setFreshnessError, longDate, debounce, sparkline } from './shared.js';
import { dataTable } from './table.js';

const UP = '#2f6b4f', DOWN = '#b0392c', GOLD = '#a67a26', SLATE = '#3f5170', INK = '#1a1714';
const NEAR_BAND = 5; // must match summarizeMa200w's default band on the backend

let allRows = [];
let trend = [];
let band = 'all';

const rupiah = v => v == null ? '—' : Math.round(v).toLocaleString('en-US');
const signedPct = v => v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%';
const tone = v => v == null ? null : (v >= 0 ? 'td-positive' : 'td-negative');
const ordinal = n => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

// ── Headline ──
function renderLede() {
  const latest = trend[trend.length - 1];
  const n = allRows.length;
  const count = f => allRows.filter(f).length;
  const share = c => (c / n * 100).toFixed(1) + '%';

  document.getElementById('universe-count').textContent = n;
  document.getElementById('hero-date').textContent = latest ? longDate(latest.date) : '—';
  const nearCount = count(r => Math.abs(r.pctFromMa) <= NEAR_BAND);
  const near = latest ? latest.pctNear : nearCount / n * 100;
  document.getElementById('near-pct').textContent = near.toFixed(1) + '%';
  document.getElementById('near-verdict').textContent = `${nearCount} of ${n} sitting at their line`;

  if (trend.length) {
    const yearAgo = trend.find(d => d.date >= shiftYear(latest.date)) || trend[0];
    document.getElementById('near-year').textContent = `${yearAgo.pctNear.toFixed(1)}%`;
    const hist = trend.map(d => d.pctNear);
    document.getElementById('near-pctile').textContent = ordinal(Math.round(hist.filter(v => v < near).length / hist.length * 100));
    const recent = trend.slice(-60);
    sparkline(document.getElementById('near-spark'), recent.map(d => d.pctNear));
    sparkline(document.getElementById('below-spark'), recent.map(d => d.pctBelow), { ref: 50, invert: true });
  }

  const below = count(r => r.pctFromMa < 0);
  document.getElementById('n-near').textContent = nearCount;
  document.getElementById('n-below').textContent = below;
  document.getElementById('pct-below').textContent = share(below);
  document.getElementById('n-above').textContent = n - below;
  document.getElementById('pct-above').textContent = share(n - below);
  document.getElementById('n-deep').textContent = count(r => r.pctFromMa < -30);
  document.getElementById('n-far').textContent = count(r => r.pctFromMa > 50);
  const sorted = allRows.map(r => r.pctFromMa).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const medEl = document.getElementById('median-dist');
  medEl.textContent = signedPct(med);
  medEl.className = 'tile-value ' + (med >= 0 ? 'up' : 'down');
}
const shiftYear = ds => (Number(ds.slice(0, 4)) - 1) + ds.slice(4);

// ── Trend charts ──
const charts = {};
function renderCharts() {
  const specs = {
    near: { panel: 'series', field: 'pctNear', legend: false, area: false, lineColor: GOLD, tipLabel: '% near', unit: '%', tipAd: false },
    // The line splits at 50%: above it, most of the market is under its own line.
    below: { panel: 'series', field: 'pctBelow', legend: false, area: false, lineColor: SLATE, tipLabel: '% below', unit: '%', ref: 50, tipAd: false },
  };
  const subs = [];
  for (const [id, spec] of Object.entries(specs)) {
    if (!charts[id]) charts[id] = new BreadthChart(document.getElementById(id + '-chart'), document.getElementById(id + '-tip'), spec);
    charts[id].setData(trend);
    subs.push(charts[id]);
  }
  // The two panels share one date axis, so hovering either marks both.
  for (const c of subs) {
    c.onHover = i => subs.forEach(o => o !== c && o.setHover(i));
    c.onLeave = () => subs.forEach(o => o !== c && o.clearHover());
  }
}

// ── Distribution ──
const SVG_NS = 'http://www.w3.org/2000/svg';
const H_MIN = -100, H_MAX = 150, H_STEP = 5;
const H_W = 1000, H_H = 220, H_TOP = 8, H_BOTTOM = 212;
const svgEl = (name, attrs) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

function renderHistogram() {
  const svg = document.getElementById('hist');
  const nBins = (H_MAX - H_MIN) / H_STEP;
  const bins = Array.from({ length: nBins }, (_, i) => ({ lo: H_MIN + i * H_STEP, count: 0 }));
  for (const r of allRows) {
    const i = Math.min(nBins - 1, Math.max(0, Math.floor((r.pctFromMa - H_MIN) / H_STEP)));
    bins[i].count++;
  }
  const peak = Math.max(...bins.map(b => b.count)) || 1;
  const bw = H_W / nBins;
  const x = v => (v - H_MIN) / (H_MAX - H_MIN) * H_W;
  svg.replaceChildren();

  const bars = bins.map((b, i) => {
    const h = (H_BOTTOM - H_TOP) * b.count / peak;
    const near = b.lo >= -NEAR_BAND && b.lo < NEAR_BAND;
    const rect = svgEl('rect', {
      x: i * bw + 1, y: H_BOTTOM - h, width: bw - 2, height: Math.max(h, b.count ? 1 : 0),
      fill: near ? GOLD : b.lo < 0 ? DOWN : UP, 'fill-opacity': near ? .9 : .5,
    });
    svg.appendChild(rect);
    return { ...b, rect };
  });
  // The line itself: zero distance.
  svg.appendChild(svgEl('line', { x1: x(0), x2: x(0), y1: 0, y2: H_BOTTOM, stroke: INK, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
  svg.appendChild(svgEl('line', { x1: 0, x2: H_W, y1: H_BOTTOM + .5, y2: H_BOTTOM + .5, stroke: INK, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));

  const axis = document.getElementById('hist-axis');
  axis.replaceChildren(...[-100, -50, 0, 50, 100, 150].map(v => {
    const s = document.createElement('span');
    s.style.cssText = `position:absolute;top:6px;left:${x(v) / H_W * 100}%;transform:translateX(${v === -100 ? '0' : v === 150 ? '-100%' : '-50%'})`;
    s.textContent = v === 0 ? 'the line' : v === 150 ? '+150%+' : (v > 0 ? '+' : '−') + Math.abs(v) + '%';
    return s;
  }));

  document.getElementById('hist-alt').textContent =
    `Histogram of ${allRows.length} stocks by distance from their own 200-week average, in 5% bands.`;

  const label = document.getElementById('hist-label');
  const readout = document.getElementById('hist-readout');
  const rest = () => { label.textContent = 'Distribution'; readout.textContent = 'Hover or tap a bar to read it.'; };
  let active = null;
  const pick = e => {
    const box = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(nBins - 1, Math.floor((e.clientX - box.left) / box.width * nBins)));
    if (active === bars[i]) return;
    if (active) active.rect.setAttribute('fill-opacity', active.lo >= -NEAR_BAND && active.lo < NEAR_BAND ? .9 : .5);
    active = bars[i];
    active.rect.setAttribute('fill-opacity', 1);
    const hi = active.lo + H_STEP;
    label.textContent = active.lo >= H_MAX - H_STEP ? `+${active.lo}% or more` : `${signedPct(active.lo)} to ${signedPct(hi)}`;
    readout.textContent = `${active.count} stock${active.count === 1 ? '' : 's'} — ${(active.count / allRows.length * 100).toFixed(1)}% of the universe`;
  };
  svg.addEventListener('pointermove', pick);
  svg.addEventListener('pointerdown', pick);
  svg.addEventListener('pointerleave', () => {
    if (active) active.rect.setAttribute('fill-opacity', active.lo >= -NEAR_BAND && active.lo < NEAR_BAND ? .9 : .5);
    active = null;
    rest();
  });
  rest();
}

// ── Tables ──
const stocks = dataTable({
  table: document.getElementById('data-table'),
  sort: { key: 'rank', dir: 1 },
  cols: [
    { key: 'rank', head: '#', desc: 'Rank by distance from the line, nearest first', get: d => d.rank },
    { key: 'ticker', head: 'Code', desc: 'IDX ticker', get: d => d.ticker, num: false },
    { key: 'price', head: 'Price', desc: 'Latest close, rupiah', get: d => rupiah(d.price) },
    { key: 'ma200w', head: '200W avg', desc: 'Average close over the trailing 200 weeks, rupiah', get: d => rupiah(d.ma200w) },
    { key: 'pctFromMa', head: 'Distance', desc: 'How far the price sits from its own 200-week average; negative means below it', get: d => signedPct(d.pctFromMa), cls: d => tone(d.pctFromMa) },
    { key: 'asOf', head: 'As of', desc: 'The most recent trading date this reading is based on', get: d => d.asOf || '—' },
  ],
  count: document.getElementById('row-count'), more: document.getElementById('row-more'), noun: ['stock', 'stocks'],
});

const days = dataTable({
  table: document.getElementById('trend-table'),
  sort: { key: 'date', dir: -1 },
  cols: [
    { key: 'date', head: 'Date', desc: 'Trading day this reading is for', get: d => d.date, num: false },
    { key: 'universeCount', head: 'Universe', desc: 'Stocks with a valid 200-week average that day', get: d => d.universeCount },
    { key: 'pctNear', head: '% Near', desc: `Share within ±${NEAR_BAND}% of their own line`, get: d => d.pctNear.toFixed(1) + '%' },
    { key: 'pctBelow', head: '% Below', desc: 'Share trading below their own line', get: d => d.pctBelow.toFixed(1) + '%', cls: d => d.pctBelow > 50 ? 'td-negative' : 'td-positive' },
  ],
  count: document.getElementById('trend-count'), more: document.getElementById('trend-more'), noun: ['day', 'days'],
});

function applyFilters() {
  const query = document.getElementById('search-input').value.trim().toLowerCase();
  stocks.render(allRows.filter(r => {
    if (band === 'near' && Math.abs(r.pctFromMa) > NEAR_BAND) return false;
    if (band === 'below' && r.pctFromMa >= 0) return false;
    if (band === 'above' && r.pctFromMa < 0) return false;
    return !query || r.ticker.toLowerCase().includes(query);
  }), { reset: true });
}

function renderDays() {
  const query = document.getElementById('trend-date-filter').value.trim();
  days.render(query ? trend.filter(d => d.date.includes(query)) : trend, { reset: true });
}

// ── Fetch ──
async function fetchData() {
  try {
    const payload = await getJson('/api/ma200w');
    if (!payload.success || !payload.data?.length) { setFreshness(null); return; }
    allRows = payload.data.slice().sort((a, b) => Math.abs(a.pctFromMa) - Math.abs(b.pctFromMa));
    allRows.forEach((r, i) => { r.rank = i + 1; });
    trend = (payload.trend || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    setFreshness(trend.length ? trend[trend.length - 1].date : payload.updatedAt?.slice(0, 10));
    renderLede();
    renderCharts();
    renderHistogram();
    applyFilters();
    renderDays();
  } catch (err) {
    console.error('Failed to load 200-week readings:', err);
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
document.getElementById('trend-date-filter').addEventListener('input', debounce(renderDays, 150));
for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[role=tab]')) {
      const on = t === tab;
      t.setAttribute('aria-pressed', String(on));
      t.setAttribute('aria-selected', String(on));
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
  });
}

fetchData();
