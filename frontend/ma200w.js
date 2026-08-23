// ══════════════════════════════════════════════════════════════════
// THE TREND LINE — proximity to each stock's own 200-week average
// The backend does the computing; this page places, filters and renders it.
// Mirrors sentiment.js (trend chart) and valuation.js (filterable table).
// ══════════════════════════════════════════════════════════════════

const API_BASE = window.location.origin;

let allRows = [];
let trend = [];
let chart = null;

// ── Palette (paper broadsheet) — matches app.js/valuation.js/sentiment.js ──
const UP = '#2f6b4f', DOWN = '#b0392c';

const rupiah = v => v == null ? '—' : Math.round(v).toLocaleString('en-US');
const signedPct = v => v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%';
const tone = v => v == null ? null : (v >= 0 ? 'td-positive' : 'td-negative');

const NEAR_BAND = 5; // must match summarizeMa200w's default band on the backend

// ── The table ──
const TABLE_COLS = [
  { head: '#', desc: 'Rank by distance from the line, nearest first', get: (d, i) => i + 1 },
  { head: 'Code', desc: 'IDX ticker', get: d => d.ticker, num: false },
  { head: 'Price', desc: 'Latest close, rupiah', get: d => rupiah(d.price) },
  { head: '200W Avg', desc: 'Average close over the trailing 200 weeks, rupiah', get: d => rupiah(d.ma200w) },
  { head: 'Distance', desc: 'How far the price sits from its own 200-week average; negative means below it', get: d => signedPct(d.pctFromMa), cls: d => tone(d.pctFromMa) },
  { head: 'As Of', desc: 'The most recent trading date this reading is based on', get: d => d.asOf || '—', num: false },
];

function renderTableHead() {
  const tr = document.querySelector('#data-table thead tr');
  if (!tr || tr.children.length) return; // static across renders
  for (const c of TABLE_COLS) {
    const th = document.createElement('th');
    if (c.num !== false) th.className = 'num';
    th.scope = 'col';
    th.title = c.desc;
    th.textContent = c.head;
    tr.appendChild(th);
  }
}

function renderTable(rows) {
  renderTableHead();
  // Built through the DOM rather than innerHTML: ticker comes straight from
  // Yahoo, and no cell should ever be parsed as markup.
  const frag = document.createDocumentFragment();
  rows.forEach((d, i) => {
    const tr = document.createElement('tr');
    for (const c of TABLE_COLS) {
      const td = document.createElement('td');
      const cls = c.cls ? c.cls(d) : null;
      if (cls) td.className = cls;
      td.textContent = c.get(d, i);
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  });
  document.querySelector('#data-table tbody').replaceChildren(frag);

  const count = document.getElementById('row-count');
  count.textContent = rows.length === allRows.length
    ? `${rows.length} stocks with a 200-week average.`
    : `${rows.length} of ${allRows.length} shown.`;
}

// ── Filtering ──
function applyFilters() {
  const band = document.getElementById('band-select').value;
  const query = document.getElementById('search-input').value.trim().toLowerCase();

  const matches = r => {
    if (band === 'near' && Math.abs(r.pctFromMa) > NEAR_BAND) return false;
    if (band === 'below' && r.pctFromMa >= 0) return false;
    if (band === 'above' && r.pctFromMa < 0) return false;
    if (query && !r.ticker.toLowerCase().includes(query)) return false;
    return true;
  };

  renderTable(allRows.filter(matches));
}

// ── The daily record (list of old days) ──
// Same click-to-sort / search convention as the front page's Daily Record
// (app.js), scaled down for this page's much smaller day count.
const TREND_COLS = [
  { key: 'date', head: 'Date', desc: 'Trading day this reading is for', get: d => d.date, num: false },
  { key: 'universeCount', head: 'Universe', desc: 'Stocks with a valid 200-week average that day', get: d => d.universeCount },
  { key: 'pctNear', head: '% Near', desc: `Share within ±${NEAR_BAND}% of their own line`, get: d => d.pctNear.toFixed(1) + '%' },
  { key: 'pctBelow', head: '% Below', desc: 'Share trading below their own line', get: d => d.pctBelow.toFixed(1) + '%' },
];

let trendSortKey = 'date';
let trendSortDir = -1; // most recent day first

function sortTrend(rows) {
  return rows.slice().sort((a, b) => {
    const x = a[trendSortKey], y = b[trendSortKey];
    return x > y ? trendSortDir : x < y ? -trendSortDir : 0;
  });
}

function renderTrendHead() {
  const tr = document.querySelector('#trend-table thead tr');
  if (!tr || tr.children.length) return; // static across renders
  for (const c of TREND_COLS) {
    const th = document.createElement('th');
    if (c.num !== false) th.className = 'num';
    th.scope = 'col';
    th.title = `${c.desc} — click to sort`;
    th.dataset.key = c.key;
    th.tabIndex = 0;
    th.textContent = c.head;
    const sort = () => {
      trendSortDir = trendSortKey === c.key ? -trendSortDir : -1;
      trendSortKey = c.key;
      renderTrendTable();
    };
    th.addEventListener('click', sort);
    th.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); }
    });
    tr.appendChild(th);
  }
}

function markTrendSorted() {
  document.querySelectorAll('#trend-table thead th').forEach(th => {
    const on = th.dataset.key === trendSortKey;
    th.dataset.sorted = on ? (trendSortDir === 1 ? 'asc' : 'desc') : '';
    th.setAttribute('aria-sort', on ? (trendSortDir === 1 ? 'ascending' : 'descending') : 'none');
  });
}

function renderTrendTable() {
  renderTrendHead();
  const query = document.getElementById('trend-date-filter').value.trim();
  const rows = sortTrend(query ? trend.filter(d => d.date.includes(query)) : trend);

  const frag = document.createDocumentFragment();
  for (const d of rows) {
    const tr = document.createElement('tr');
    for (const c of TREND_COLS) {
      const td = document.createElement('td');
      td.textContent = c.get(d);
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  document.querySelector('#trend-table tbody').replaceChildren(frag);
  markTrendSorted();

  const count = document.getElementById('trend-count');
  count.textContent = query
    ? `${rows.length} of ${trend.length} days match.`
    : `${rows.length} days on record.`;
}

// ── Lede ──
function renderLede() {
  const latest = trend[trend.length - 1];
  if (!latest) return;

  document.getElementById('near-pct').textContent = latest.pctNear.toFixed(1) + '%';
  document.getElementById('near-verdict').textContent = 'Sitting Near Their Line';
  document.getElementById('universe-count').textContent = latest.universeCount;
  document.getElementById('universe-count-2').textContent = latest.universeCount;

  const nearCount = Math.round(latest.pctNear / 100 * latest.universeCount);
  document.getElementById('near-count').textContent = nearCount;

  document.getElementById('below-note').textContent =
    `${latest.pctBelow.toFixed(1)}% of the usable universe is trading below its own 200-week average today.`;
}

function renderChart() {
  const canvas = document.getElementById('ma200w-chart');
  const tip = document.getElementById('ma200w-tip');
  if (!canvas) return;
  if (!chart) {
    chart = new BreadthChart(canvas, tip, {
      panel: 'series', field: 'pctNear', label: '% NEAR THEIR LINE',
      tipLabel: `Within ±${NEAR_BAND}%`, legendLabel: '% near', unit: '%', tipAd: false,
    });
  }
  chart.setData(trend);
}

function showEmpty(message) {
  document.getElementById('last-updated').textContent = message;
  document.getElementById('near-verdict').textContent = message;
  document.getElementById('row-count').textContent = message;
}

// ── Fetch ──
async function fetchData() {
  try {
    // Cache-buster: CloudFront otherwise serves a stale reading.
    const res = await fetch(`${API_BASE}/api/ma200w`);
    const json = await res.json();

    // Handle REST API v1 double-wrapped response
    let payload = json;
    if (json.body && json.statusCode) payload = JSON.parse(json.body);

    if (!payload.success || !payload.data?.length) {
      showEmpty('No 200-week readings on record yet.');
      return;
    }

    // The backend already ranks these; sort again so the page never depends
    // on the order a stored payload happens to arrive in.
    allRows = payload.data.slice().sort((a, b) => Math.abs(a.pctFromMa) - Math.abs(b.pctFromMa));
    trend = (payload.trend || []).slice().sort((a, b) => a.date.localeCompare(b.date));

    const stamp = payload.updatedAt ? new Date(payload.updatedAt) : null;
    document.getElementById('last-updated').textContent = stamp
      ? `Last: ${stamp.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`
      : 'Reading on record';

    renderLede();
    renderChart();
    applyFilters();
    renderTrendTable();
  } catch (err) {
    console.error('Failed to load 200-week readings:', err);
    showEmpty('Could not load the record.');
  }
}

document.getElementById('band-select').addEventListener('change', applyFilters);
document.getElementById('search-input').addEventListener('input', applyFilters);
document.getElementById('trend-date-filter').addEventListener('input', renderTrendTable);
fetchData();
