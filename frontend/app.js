// ──────────────────────────────────────────────
// IHSG A/D Index — Frontend App
// ──────────────────────────────────────────────

const API_BASE = window.location.origin;

// Raw daily % Advancing is very noisy (each session is a fresh draw of ~500
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
  fetchData();
});

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
  const range = parseInt(document.getElementById('range-select').value);
  if (range === 0) return allData;
  return allData.slice(-range);
}

function renderAll() {
  const data = getFilteredData();
  HoverSync.reset();
  renderCards(data);
  renderBreadth(data);
  renderADRatio(data);
  renderMcClellan(data);
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

// ── A/D Ratio Chart ──
function renderADRatio(data) {
  const ctx = document.getElementById('ad-ratio-chart').getContext('2d');
  if (charts.adRatio) charts.adRatio.destroy();

  const colors = data.map(d => d.ratio >= 1 ? UP_BAR : DOWN_BAR);

  charts.adRatio = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => d.date),
      datasets: [{
        label: 'A/D Ratio',
        data: data.map(d => d.ratio),
        backgroundColor: colors,
        borderWidth: 0,
        borderRadius: 2,
      }, {
        label: 'Neutral (1.0)',
        data: data.map(() => 1),
        type: 'line',
        borderColor: 'rgba(166,122,38,0.6)',
        borderWidth: 1,
        borderDash: [5, 5],
        pointRadius: 0,
        fill: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TIP,
          callbacks: {
            label: (ctx) => {
              if (ctx.datasetIndex === 1) return '';
              return `Ratio: ${ctx.parsed.y.toFixed(2)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 8, maxRotation: 0 },
        },
        y: {
          grid: { color: GRID },
          suggestedMin: 0,
        },
      },
    },
  });

  linkChartJs(charts.adRatio);
}

// ── McClellan Oscillator Chart ──
function renderMcClellan(data) {
  const ctx = document.getElementById('mcclellan-chart').getContext('2d');
  if (charts.mcclellan) charts.mcclellan.destroy();

  const colors = data.map(d => d.mcClellan >= 0 ? UP_BAR : DOWN_BAR);

  charts.mcclellan = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => d.date),
      datasets: [{
        label: 'McClellan Oscillator',
        data: data.map(d => d.mcClellan),
        backgroundColor: colors,
        borderWidth: 0,
        borderRadius: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TIP,
          callbacks: {
            label: (ctx) => `McClellan: ${ctx.parsed.y.toFixed(1)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 8, maxRotation: 0 },
        },
        y: {
          grid: { color: GRID },
        },
      },
    },
  });

  linkChartJs(charts.mcclellan);
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
      <td>${d.ratio.toFixed(2)}</td>
      <td class="${d.pctAdvancing != null && d.pctAdvancing >= 50 ? 'td-positive' : 'td-negative'}">${d.pctAdvancing != null ? d.pctAdvancing.toFixed(1) + '%' : '—'}</td>
      <td class="${d.mcClellan >= 0 ? 'td-positive' : 'td-negative'}">${d.mcClellan >= 0 ? '+' : ''}${d.mcClellan.toFixed(1)}</td>
    </tr>
  `).join('');
}
