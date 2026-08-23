// ──────────────────────────────────────────────
// Market Sentiment — Frontend App (standalone, mirrors app.js/valuation.js)
// ──────────────────────────────────────────────

const API_BASE = window.location.origin;

let allData = [];
let chart = null;

// ── Palette (paper broadsheet) — matches app.js's UP/DOWN/ZONE_* constants ──
const UP = '#2f6b4f', DOWN = '#b0392c';
const ZONE_UP = 'rgba(47,107,79,0.10)', ZONE_DOWN = 'rgba(176,57,44,0.09)';

const signed = (v) => v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(Math.round(v));

// ── Fetch ──
async function fetchData() {
  try {
    // Cache-buster: CloudFront otherwise caches /api/sentiment.
    const res = await fetch(`${API_BASE}/api/sentiment`);
    const json = await res.json();

    // Handle REST API v1 double-wrapped response
    let data = json;
    if (json.body && json.statusCode) data = JSON.parse(json.body);

    if (data.success && data.data && data.data.length > 0) {
      allData = data.data;
      document.getElementById('last-updated').textContent = `Last: ${allData[allData.length - 1].date}`;
      renderAll();
    } else {
      showEmpty('No reading yet');
    }
  } catch (err) {
    console.error('Fetch error:', err);
    document.getElementById('last-updated').textContent = `Error: ${err.message}`;
  }
}

async function refreshData() {
  const btn = document.getElementById('refresh-btn');
  const lastUpdated = document.getElementById('last-updated');
  btn.disabled = true;
  btn.textContent = 'Reading...';
  lastUpdated.textContent = 'Reading today’s headlines...';

  try {
    const res = await fetch(`${API_BASE}/api/sentiment/refresh`, { method: 'POST' });
    const json = await res.json();

    if (json.success) {
      btn.textContent = '✓ Done';
      lastUpdated.textContent = `Read: ${json.date || 'just now'}`;
      setTimeout(() => { btn.textContent = 'Re-read'; btn.disabled = false; }, 2000);
      await fetchData();
    } else {
      btn.textContent = '✗ Failed';
      lastUpdated.textContent = `Failed: ${json.message || 'unknown error'}`;
      lastUpdated.style.color = DOWN;
      setTimeout(() => {
        btn.textContent = 'Re-read';
        btn.disabled = false;
        lastUpdated.style.color = '';
      }, 5000);
    }
  } catch (err) {
    btn.textContent = '✗ Error';
    lastUpdated.textContent = `Error: ${err.message}`;
    lastUpdated.style.color = DOWN;
    setTimeout(() => { btn.textContent = 'Re-read'; btn.disabled = false; lastUpdated.style.color = ''; }, 5000);
  }
}

function showEmpty(msg) {
  document.getElementById('last-updated').textContent = msg || 'No data';
  document.getElementById('sentiment-verdict').textContent = msg || 'No reading yet';
}

// ── Render ──
function renderAll() {
  renderLede();
  renderChart();
}

function renderLede() {
  const latest = allData[allData.length - 1];
  const score = latest.score;

  const scoreEl = document.getElementById('sentiment-score');
  scoreEl.textContent = signed(score);
  scoreEl.style.color = score >= 0 ? UP : DOWN;

  document.getElementById('sentiment-verdict').textContent = latest.label
    ? latest.label.charAt(0).toUpperCase() + latest.label.slice(1)
    : (score >= 0 ? 'Reading Bullish' : 'Reading Bearish');
  document.getElementById('sentiment-verdict').style.color = score >= 0 ? UP : DOWN;

  document.getElementById('sentiment-summary').textContent = latest.summary || 'No summary filed for this session.';
  document.getElementById('sentiment-headline-count').textContent = latest.headlineCount ?? '—';
  document.getElementById('reading-count').textContent = allData.length;
}

function renderChart() {
  const canvas = document.getElementById('sentiment-chart');
  const tip = document.getElementById('sentiment-tip');
  if (!canvas) return;
  if (!chart) {
    chart = new BreadthChart(canvas, tip, {
      panel: 'series', field: 'score', label: 'SENTIMENT', tipLabel: 'Score', legendLabel: 'score',
      ref: 0, yMin: -100, yMax: 100, tipAd: false,
      zones: [
        { from: 0, to: Infinity, fill: ZONE_UP },
        { from: -Infinity, to: 0, fill: ZONE_DOWN },
      ],
    });
  }
  chart.setData(allData);
}

// ── Init ──
document.getElementById('refresh-btn').addEventListener('click', refreshData);
fetchData();
