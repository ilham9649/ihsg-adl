// ──────────────────────────────────────────────
// IHSG A/D Index — Frontend App
// ──────────────────────────────────────────────

const API_BASE = window.location.origin;

// Raw daily % Advancing is very noisy (each session is a fresh draw of ~950
// stocks), so the breadth line is smoothed with a trailing moving average.
// Computed over the FULL series (not the sliced range) so the visible window has
// no warmup gap. Tune the window here.
const PCT_SMOOTH_WINDOW = 20;
// Moving averages of % Advancing drawn on the breadth line (data field → window).
const PCT_MAS = { pctAdvancingMA: 20, pctAdvancingMA100: 100, pctAdvancingMA200: 200 };

let allData = [];
let charts = {};
let ihsgChart = null;
let adlineChart = null;

// Attach a trailing SMA of pctAdvancing for each window, computed over the FULL
// series (so the visible range has no warmup gap). Uses whatever prior values
// exist (shorter effective window at the very start → no gaps).
function attachPctSmoothing(rows) {
  const vals = rows.map(r => (r.pctAdvancing != null ? r.pctAdvancing : null));
  for (const [field, window] of Object.entries(PCT_MAS)) {
    for (let i = 0; i < rows.length; i++) {
      let sum = 0, cnt = 0;
      for (let k = Math.max(0, i - window + 1); k <= i; k++) {
        if (vals[k] != null) { sum += vals[k]; cnt++; }
      }
      rows[i][field] = cnt ? parseFloat((sum / cnt).toFixed(2)) : null;
    }
  }
}

// ISO-week key for a YYYY-MM-DD date; and weekly OHLC bars of the IHSG index
// (shared by the weekly index oscillators below).
function isoWeek(ds) {
  const dt = new Date(ds + 'T00:00:00Z');
  const day = (dt.getUTCDay() + 6) % 7;
  const th = new Date(dt); th.setUTCDate(dt.getUTCDate() - day + 3);
  const y = th.getUTCFullYear();
  const w = Math.floor((th - new Date(Date.UTC(y, 0, 1))) / (7 * 864e5)) + 1;
  return y + '-' + String(w).padStart(2, '0');
}
function weeklyBars(rows) {
  const weeks = [], idx = {};
  for (const r of rows) {
    if (r.ihsg == null) continue;
    const k = isoWeek(r.date);
    let w = idx[k];
    if (!w) { w = idx[k] = { key: k, high: r.ihsgHigh ?? r.ihsg, low: r.ihsgLow ?? r.ihsg, close: r.ihsg }; weeks.push(w); }
    w.high = Math.max(w.high, r.ihsgHigh ?? r.ihsg);
    w.low = Math.min(w.low, r.ihsgLow ?? r.ihsg);
    w.close = r.ihsg;
  }
  return weeks;
}

// Weekly Stochastic (15,3,3) of the IHSG index, attached to each daily row (a
// long-horizon oversold/overbought gauge).
function attachStochastic(rows, kLen = 15, kSmooth = 3, dSmooth = 3) {
  const weeks = weeklyBars(rows);
  const rawK = weeks.map((w, i) => {
    if (i < kLen - 1) return null;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kLen + 1; j <= i; j++) { hi = Math.max(hi, weeks[j].high); lo = Math.min(lo, weeks[j].low); }
    return hi > lo ? 100 * (w.close - lo) / (hi - lo) : 50;
  });
  const sma = (arr, n, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - n + 1); j <= i; j++) if (arr[j] != null) { s += arr[j]; c++; } return c ? s / c : null; };
  const K = rawK.map((v, i) => v == null ? null : sma(rawK, kSmooth, i));
  const D = K.map((v, i) => v == null ? null : sma(K, dSmooth, i));
  const wk = {};
  weeks.forEach((w, i) => { wk[w.key] = { K: K[i], D: D[i] }; });
  for (const r of rows) {
    const s = r.ihsg != null ? wk[isoWeek(r.date)] : null;
    r.stochK = s && s.K != null ? parseFloat(s.K.toFixed(1)) : null;
    r.stochD = s && s.D != null ? parseFloat(s.D.toFixed(1)) : null;
  }
}

// Weekly Shinohara Intensity Ratio (26) of the IHSG — the EXACT formula Yahoo
// Finance uses (from its ChartIQ study library), so our numbers match Yahoo's:
//   Strong Ratio = 100 · Σ(High − prevClose) / Σ(prevClose − Low)   over 26 weeks
//   Weak Ratio   = 100 · Σ(High − Close)     / Σ(Close − Low)       over 26 weeks
// Weak − Strong > 100 is a rare "extremely oversold" reading (a bottom signal).
function attachShinohara(rows, period = 26) {
  const weeks = weeklyBars(rows);
  const val = {};
  for (let i = 0; i < weeks.length; i++) {
    if (i < period) { val[weeks[i].key] = { strong: null, weak: null }; continue; }
    let wn = 0, wd = 0, sn = 0, sd = 0;
    for (let k = i - period + 1; k <= i; k++) {
      const b = weeks[k], pc = weeks[k - 1].close;
      wn += b.high - b.close; wd += b.close - b.low;
      sn += b.high - pc; sd += pc - b.low;
    }
    val[weeks[i].key] = {
      strong: sd !== 0 ? parseFloat((100 * sn / sd).toFixed(1)) : null,
      weak: wd !== 0 ? parseFloat((100 * wn / wd).toFixed(1)) : null,
    };
  }
  for (const r of rows) {
    const v = r.ihsg != null ? val[isoWeek(r.date)] : null;
    r.shinStrong = v ? v.strong : null;
    r.shinWeak = v ? v.weak : null;
  }
}

// ── Palette (paper broadsheet) ──
const INK = '#1d1813', PAPER = '#f2ebdd', GOLD = '#a67a26';
const UP = '#2f6b4f', DOWN = '#b0392c';
const UP_BAR = 'rgba(47,107,79,0.72)', DOWN_BAR = 'rgba(176,57,44,0.72)';
const GRID = 'rgba(29,24,19,0.06)';
const TIP = { backgroundColor: INK, titleColor: PAPER, bodyColor: PAPER, borderColor: GOLD, borderWidth: 1, cornerRadius: 0, padding: 10, titleFont: { family: "'JetBrains Mono', monospace" }, bodyFont: { family: "'JetBrains Mono', monospace" } };

// ── Chart defaults ──
Chart.defaults.color = '#5b5147';
Chart.defaults.borderColor = GRID;
Chart.defaults.font.family = "'JetBrains Mono', monospace";
Chart.defaults.font.size = 11;

// ── Cross-chart hover sync ──
// Every panel shares the same filtered data array, so a hovered position maps to
// the same index everywhere. Hovering one chart highlights that date in all the
// others. Subscribers are rebuilt on each renderAll (Chart.js charts are
// recreated), so we reset the list there.
const HoverSync = {
  subs: [],
  reset() { this.subs = []; },
  register(sub) { this.subs.push(sub); return sub; },
  emit(i, src) { for (const s of this.subs) if (s !== src) s.show(i); },
  clear(src) { for (const s of this.subs) if (s !== src) s.hide(); },
};

// Link a custom BreadthChart into the sync bus.
function linkBreadth(bc) {
  const sub = { show: (i) => bc.setHover(i), hide: () => bc.clearHover() };
  HoverSync.register(sub);
  bc.onHover = (i) => HoverSync.emit(i, sub);
  bc.onLeave = () => HoverSync.clear(sub);
}

// Link a Chart.js chart into the sync bus (programmatic tooltip + active element).
function linkChartJs(chart) {
  const sub = {
    show: (i) => {
      if (chart._syncIdx === i) return;
      const el = chart.getDatasetMeta(0)?.data?.[i];
      if (!el) return;
      chart._syncIdx = i;
      chart.setActiveElements([{ datasetIndex: 0, index: i }]);
      chart.tooltip.setActiveElements([{ datasetIndex: 0, index: i }], { x: el.x, y: el.y });
      chart.update('none');
    },
    hide: () => {
      if (chart._syncIdx == null) return;
      chart._syncIdx = null;
      chart.setActiveElements([]);
      chart.tooltip.setActiveElements([], { x: 0, y: 0 });
      chart.update('none');
    },
  };
  HoverSync.register(sub);
  chart.options.onHover = (_evt, els) => { if (els && els.length) HoverSync.emit(els[0].index, sub); };
  chart.canvas.addEventListener('mouseleave', () => HoverSync.clear(sub));
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('range-select').addEventListener('change', () => renderAll());
  document.getElementById('refresh-btn').addEventListener('click', refreshData);
  document.querySelectorAll('#ma-checklist input[type=checkbox]')
    .forEach(cb => cb.addEventListener('change', applyMaToggles));
  fetchData();
});

// Show/hide breadth lines from the checklist (unchecked → hidden key).
function applyMaToggles() {
  if (!adlineChart) return;
  const hidden = new Set();
  document.querySelectorAll('#ma-checklist input[type=checkbox]')
    .forEach(cb => { if (!cb.checked) hidden.add(cb.dataset.key); });
  adlineChart.setHidden(hidden);
}

// ── Fetch ──
async function fetchData() {
  try {
    // Cache-buster: CloudFront otherwise caches /api/ad and the dashboard
    // shows stale data after a refresh.
    const url = `${API_BASE}/api/ad?_=${Date.now()}`;
    const res = await fetch(url);
    const json = await res.json();

    // Handle REST API v1 double-wrapped response
    let data = json;
    if (json.body && json.statusCode) {
      try {
        data = JSON.parse(json.body);
      } catch (parseErr) {
        console.error('Failed to parse wrapped response:', parseErr);
        showEmpty('API response format error');
        return;
      }
    }

    if (data.success && data.data && data.data.length > 0) {
      allData = data.data;
      attachPctSmoothing(allData);
      attachStochastic(allData);
      attachShinohara(allData);
      document.getElementById('last-updated').textContent = `Last: ${allData[allData.length - 1].date}`;
      renderAll();
    } else {
      showEmpty('No data yet');
    }
  } catch (err) {
    console.error('Fetch error:', err);
    document.getElementById('last-updated').textContent = `Error: ${err.message}`;
    // Show refresh prompt using safe DOM methods
    const cards = document.querySelector('.cards');
    cards.innerHTML = '';
    const errorCard = document.createElement('div');
    errorCard.className = 'card';
    errorCard.style.gridColumn = '1 / -1';
    errorCard.innerHTML = '<div class="card-label">Error</div>';
    const errorValue = document.createElement('div');
    errorValue.className = 'card-value';
    errorValue.style.fontSize = '0.85rem';
    errorValue.style.color = '#ef4444';
    errorValue.textContent = err.message;
    errorCard.appendChild(errorValue);
    cards.appendChild(errorCard);
  }
}

async function refreshData() {
  const btn = document.getElementById('refresh-btn');
  const lastUpdated = document.getElementById('last-updated');
  btn.disabled = true;
  btn.textContent = 'Refreshing...';
  lastUpdated.textContent = 'Refreshing data...';

  try {
    const res = await fetch(`${API_BASE}/api/ad/refresh`, { method: 'POST' });
    const json = await res.json();

    if (json.success) {
      btn.textContent = '✓ Done';
      lastUpdated.textContent = `Refreshed: ${json.latestDate || 'just now'}`;
      setTimeout(() => { btn.textContent = '↻ Refresh'; btn.disabled = false; }, 2000);
      // Re-fetch
      await fetchData();
    } else {
      btn.textContent = '✗ Failed';
      const errorMsg = json.locked ? ' (refresh in progress)' : json.message || 'unknown error';
      lastUpdated.textContent = `Failed:${errorMsg}`;
      lastUpdated.style.color = '#ef4444';
      setTimeout(() => {
        btn.textContent = '↻ Refresh';
        btn.disabled = false;
        lastUpdated.style.color = '';
      }, 5000);
    }
  } catch (err) {
    btn.textContent = '✗ Error';
    document.getElementById('last-updated').textContent = `Error: ${err.message}`;
    document.getElementById('last-updated').style.color = '#ef4444';
    setTimeout(() => { btn.textContent = '↻ Refresh'; btn.disabled = false; }, 2000);
  }
}

function showEmpty(msg) {
  document.getElementById('last-updated').textContent = msg || 'No data';
}

// ── Render ──
function getFilteredData() {
  const raw = document.getElementById('range-select').value;
  if (raw === 'ytd') {
    const jan1 = new Date().getFullYear() + '-01-01';
    return allData.filter(d => d.date >= jan1);
  }
  const range = parseInt(raw, 10);
  if (!range) return allData; // 0 / NaN → Full Record
  return allData.slice(-range);
}

function renderAll() {
  const data = getFilteredData();
  HoverSync.reset();
  renderCards(data);
  renderBreadth(data);
  renderStochastic(data);
  renderShinohara(data);
  renderTable(data);
}

// ── IHSG price + A/D Line (two separate charts) ──
function renderBreadth(data) {
  const pc = document.getElementById('ihsg-chart');
  const pt = document.getElementById('ihsg-tip');
  if (pc && pt) {
    if (!ihsgChart) ihsgChart = new BreadthChart(pc, pt, { panel: 'price' });
    ihsgChart.setData(data);
    linkBreadth(ihsgChart);
  }
  const ac = document.getElementById('adline-chart');
  const at = document.getElementById('adline-tip');
  if (ac && at) {
    if (!adlineChart) adlineChart = new BreadthChart(ac, at, {
      panel: 'series', field: 'pctAdvancingMA', rawField: 'pctAdvancing',
      label: '% ADVANCING', tipLabel: `${PCT_SMOOTH_WINDOW}-day avg`,
      legendLabel: `${PCT_SMOOTH_WINDOW}d`, ref: 50, unit: '%',
      overlays: [
        { field: 'pctAdvancingMA100', color: '#a67a26', width: 1.4, label: '100-day', legend: '100d' },
        { field: 'pctAdvancingMA200', color: '#3f5170', width: 1.6, label: '200-day', legend: '200d' },
      ],
    });
    adlineChart.setData(data);
    linkBreadth(adlineChart);
  }
}

// ── Cards ──
function renderCards(data) {
  if (data.length === 0) return;
  const latest = data[data.length - 1];

  // Hero — today's % Advancing and the plain-language verdict
  const pa = latest.pctAdvancing;
  const heroNum = document.getElementById('pct-advancing');
  const heroVerdict = document.getElementById('pct-verdict');
  const heroMa = document.getElementById('pct-advancing-ma');
  if (heroNum && pa != null) {
    heroNum.textContent = pa.toFixed(1) + '%';
    heroNum.style.color = pa >= 50 ? UP : DOWN;
  }
  if (heroVerdict && pa != null) {
    const broad = pa >= 50;
    heroVerdict.textContent = broad ? 'A Broad Advance' : 'A Narrowing Market';
    heroVerdict.style.color = broad ? UP : DOWN;
  }
  if (heroMa && latest.pctAdvancingMA != null) {
    heroMa.textContent = latest.pctAdvancingMA.toFixed(1) + '%';
  }

  // Constituents actually counted in the latest session (transparency: the full
  // discovered IDX universe, minus any that didn't trade / lacked a prior close).
  const universe = document.getElementById('universe-count');
  if (universe) universe.textContent = latest.advances + latest.declines + latest.unchanged;

  document.getElementById('advances').textContent = latest.advances;
  document.getElementById('declines').textContent = latest.declines;
  document.getElementById('unchanged').textContent = latest.unchanged;
  document.getElementById('ratio').textContent = latest.ratio.toFixed(2);
  document.getElementById('spread').textContent = (latest.spread >= 0 ? '+' : '') + latest.spread;
  document.getElementById('mcclellan').textContent = (latest.mcClellan >= 0 ? '+' : '') + latest.mcClellan.toFixed(1);

  // Color the spread & mcclellan figures
  document.getElementById('spread').style.color = latest.spread >= 0 ? UP : DOWN;
  document.getElementById('mcclellan').style.color = latest.mcClellan >= 0 ? UP : DOWN;
}

// ── Stochastic Oscillator (IHSG weekly, 15,3,3) ──
function renderStochastic(data) {
  const ctx = document.getElementById('stoch-chart').getContext('2d');
  if (charts.stoch) charts.stoch.destroy();

  const labels = data.map(d => d.date);
  charts.stoch = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        // shaded zones: 0-20 (oversold, green) and 80-100 (overbought, red)
        { label: '_oversold', data: data.map(() => 20), borderColor: 'rgba(29,24,19,0.28)', borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: 'start', backgroundColor: 'rgba(47,107,79,0.10)' },
        { label: '_overbought', data: data.map(() => 80), borderColor: 'rgba(29,24,19,0.28)', borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: 'end', backgroundColor: 'rgba(176,57,44,0.09)' },
        { label: '%K', data: data.map(d => d.stochK), borderColor: '#3f5170', borderWidth: 1.6, pointRadius: 0, tension: 0.15, spanGaps: true },
        { label: '%D', data: data.map(d => d.stochD), borderColor: GOLD, borderWidth: 1.6, pointRadius: 0, tension: 0.15, spanGaps: true },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 14, filter: (it) => it.text === '%K' || it.text === '%D' } },
        tooltip: { ...TIP, filter: (it) => it.dataset.label === '%K' || it.dataset.label === '%D', callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y != null ? c.parsed.y.toFixed(1) : '—'}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
        y: { min: 0, max: 100, grid: { color: GRID }, ticks: { stepSize: 20 } },
      },
    },
  });

  linkChartJs(charts.stoch);
}

// ── Shinohara Intensity Ratio (IHSG weekly, 26) — matches Yahoo/ChartIQ ──
function renderShinohara(data) {
  const ctx = document.getElementById('shinohara-chart').getContext('2d');
  if (charts.shinohara) charts.shinohara.destroy();

  const labels = data.map(d => d.date);
  charts.shinohara = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Weak', data: data.map(d => d.shinWeak), borderColor: '#5F7CB8', borderWidth: 1.6, pointRadius: 0, tension: 0.15, spanGaps: true },
        // fill the gap between the two lines (a wide gap = the oversold signal)
        { label: 'Strong', data: data.map(d => d.shinStrong), borderColor: '#E99B54', borderWidth: 1.6, pointRadius: 0, tension: 0.15, spanGaps: true, fill: '-1', backgroundColor: 'rgba(95,124,184,0.09)' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 14 } },
        tooltip: {
          ...TIP,
          callbacks: {
            label: (c) => `${c.dataset.label}: ${c.parsed.y != null ? c.parsed.y.toFixed(1) : '—'}`,
            afterBody: (items) => {
              const d = data[items[0].dataIndex];
              if (d.shinWeak == null || d.shinStrong == null) return '';
              const diff = d.shinWeak - d.shinStrong;
              return `Weak − Strong: ${diff.toFixed(1)}${diff > 100 ? '  ⚠ extremely oversold' : ''}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
        y: { grid: { color: GRID }, suggestedMin: 0 },
      },
    },
  });

  linkChartJs(charts.shinohara);
}

// ── Data Table ──
function renderTable(data) {
  const tbody = document.querySelector('#data-table tbody');
  // Show latest first
  const reversed = [...data].reverse();

  tbody.innerHTML = reversed.map(d => `
    <tr>
      <td>${d.date}</td>
      <td class="td-advance">${d.advances}</td>
      <td class="td-decline">${d.declines}</td>
      <td>${d.unchanged}</td>
      <td class="${d.spread >= 0 ? 'td-positive' : 'td-negative'}">${d.spread >= 0 ? '+' : ''}${d.spread}</td>
      <td class="${d.pctAdvancing != null && d.pctAdvancing >= 50 ? 'td-positive' : 'td-negative'}">${d.pctAdvancing != null ? d.pctAdvancing.toFixed(1) + '%' : '—'}</td>
    </tr>
  `).join('');
}
