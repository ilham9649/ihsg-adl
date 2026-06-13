// ──────────────────────────────────────────────
// IHSG A/D Index — Frontend App
// ──────────────────────────────────────────────

const API_BASE = window.location.origin;

let allData = [];
let charts = {};

// ── Chart defaults ──
Chart.defaults.color = '#8899aa';
Chart.defaults.borderColor = 'rgba(255,255,255,0.05)';
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.font.size = 12;

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
  renderCards(data);
  renderADRatio(data);
  renderMcClellan(data);
  renderAdvDec(data);
  renderTable(data);
}

// ── Cards ──
function renderCards(data) {
  if (data.length === 0) return;
  const latest = data[data.length - 1];

  document.getElementById('advances').textContent = latest.advances;
  document.getElementById('declines').textContent = latest.declines;
  document.getElementById('unchanged').textContent = latest.unchanged;
  document.getElementById('ratio').textContent = latest.ratio.toFixed(2);
  document.getElementById('spread').textContent = (latest.spread >= 0 ? '+' : '') + latest.spread;
  document.getElementById('mcclellan').textContent = (latest.mcClellan >= 0 ? '+' : '') + latest.mcClellan.toFixed(1);

  // Color the spread & mcclellan cards
  document.getElementById('spread').style.color = latest.spread >= 0 ? '#22c55e' : '#ef4444';
  document.getElementById('mcclellan').style.color = latest.mcClellan >= 0 ? '#a855f7' : '#ef4444';
}

// ── A/D Ratio Chart ──
function renderADRatio(data) {
  const ctx = document.getElementById('ad-ratio-chart').getContext('2d');
  if (charts.adRatio) charts.adRatio.destroy();

  const colors = data.map(d => d.ratio >= 1 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)');

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
        borderColor: 'rgba(201,169,110,0.5)',
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
          backgroundColor: '#16213e',
          borderColor: 'rgba(201,169,110,0.3)',
          borderWidth: 1,
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
          grid: { color: 'rgba(255,255,255,0.03)' },
          suggestedMin: 0,
        },
      },
    },
  });

  document.getElementById('ad-ratio-chart').parentElement.style.height = '350px';
  charts.adRatio.canvas.style.height = '100%';
}

// ── McClellan Oscillator Chart ──
function renderMcClellan(data) {
  const ctx = document.getElementById('mcclellan-chart').getContext('2d');
  if (charts.mcclellan) charts.mcclellan.destroy();

  const colors = data.map(d =>
    d.mcClellan >= 0 ? 'rgba(168,85,247,0.7)' : 'rgba(239,68,68,0.7)'
  );

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
          backgroundColor: '#16213e',
          borderColor: 'rgba(201,169,110,0.3)',
          borderWidth: 1,
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
          grid: { color: 'rgba(255,255,255,0.03)' },
        },
      },
    },
  });

  document.getElementById('mcclellan-chart').parentElement.style.height = '350px';
  charts.mcclellan.canvas.style.height = '100%';
}

// ── Advances vs Declines Chart ──
function renderAdvDec(data) {
  const ctx = document.getElementById('advdec-chart').getContext('2d');
  if (charts.advdec) charts.advdec.destroy();

  charts.advdec = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => d.date),
      datasets: [{
        label: 'Advances',
        data: data.map(d => d.advances),
        backgroundColor: 'rgba(34,197,94,0.6)',
        borderWidth: 0,
        borderRadius: 2,
      }, {
        label: 'Declines',
        data: data.map(d => d.declines),
        backgroundColor: 'rgba(239,68,68,0.6)',
        borderWidth: 0,
        borderRadius: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { boxWidth: 12, padding: 16 },
        },
        tooltip: {
          backgroundColor: '#16213e',
          borderColor: 'rgba(201,169,110,0.3)',
          borderWidth: 1,
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { maxTicksLimit: 8, maxRotation: 0 },
        },
        y: {
          stacked: true,
          grid: { color: 'rgba(255,255,255,0.03)' },
          suggestedMax: data.length > 0 ? Math.max(...data.map(d => Math.max(d.advances, d.declines))) * 1.2 : undefined,
        },
      },
    },
  });

  document.getElementById('advdec-chart').parentElement.style.height = '350px';
  charts.advdec.canvas.style.height = '100%';
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
      <td class="${d.mcClellan >= 0 ? 'td-positive' : 'td-negative'}">${d.mcClellan >= 0 ? '+' : ''}${d.mcClellan.toFixed(1)}</td>
    </tr>
  `).join('');
}
