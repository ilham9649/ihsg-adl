// ──────────────────────────────────────────────
// Sentiment — the daily LLM reading of the headlines.
// ──────────────────────────────────────────────
import { BreadthChart } from './breadth-chart.js';
import { getJson, setFreshness, setFreshnessError, ageInDays, longDate } from './shared.js';

const UP = '#2f6b4f', DOWN = '#b0392c';
const ZONE_UP = 'rgba(47,107,79,0.08)', ZONE_DOWN = 'rgba(176,57,44,0.07)';
// The job runs nightly, so anything older than this has stopped, not paused
// for a weekend or a holiday.
const STALE_DAYS = 3;
const SCORE_MA_WINDOW = 7;

const signed = v => v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(Math.round(v));

// One read a day is noisy score-to-score, so smooth it with a trailing average.
function attachScoreSmoothing(rows) {
  for (let i = 0; i < rows.length; i++) {
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, i - SCORE_MA_WINDOW + 1); k <= i; k++) {
      if (rows[k].score != null) { sum += rows[k].score; cnt++; }
    }
    rows[i].scoreMA = cnt ? parseFloat((sum / cnt).toFixed(2)) : null;
  }
}

function renderLede(rows) {
  const latest = rows[rows.length - 1];
  const age = ageInDays(latest.date);
  const stale = age > STALE_DAYS;
  const up = latest.score >= 0;

  document.getElementById('reading-count').textContent = rows.length;
  document.getElementById('hero-kicker').textContent = stale ? 'Last reading on file' : 'Latest reading';
  document.getElementById('hero-date').textContent = longDate(latest.date, { weekday: 'short' });
  const score = document.getElementById('sentiment-score');
  score.textContent = signed(latest.score);
  score.style.color = up ? UP : DOWN;
  const verdict = document.getElementById('sentiment-verdict');
  verdict.textContent = latest.label ? latest.label[0].toUpperCase() + latest.label.slice(1) : (up ? 'Bullish' : 'Bearish');
  verdict.style.color = up ? UP : DOWN;
  document.getElementById('score-ma').textContent = signed(latest.scoreMA);
  document.getElementById('headline-count').textContent = latest.headlineCount ?? '—';
  document.getElementById('sentiment-summary').textContent = latest.summary || 'No summary filed for this session.';

  // A stale mood dressed as today's is the one thing this page must not show.
  const notice = document.getElementById('stale-notice');
  notice.hidden = !stale;
  if (stale) {
    const b = document.createElement('b');
    b.textContent = `Not updated for ${age} days.`;
    notice.replaceChildren(b, ` The latest reading is from ${longDate(latest.date)}; the nightly job has stopped filing since. The figures below are the last ones on record.`);
  }
}

let chart = null;
function renderChart(rows) {
  const canvas = document.getElementById('sentiment-chart');
  if (!chart) {
    chart = new BreadthChart(canvas, document.getElementById('sentiment-tip'), {
      panel: 'series', field: 'scoreMA', rawField: 'score', legend: false,
      label: 'SENTIMENT', tipLabel: `${SCORE_MA_WINDOW}-day avg`,
      ref: 0, yMin: -100, yMax: 100, tipAd: false,
      zones: [
        { from: 0, to: Infinity, fill: ZONE_UP },
        { from: -Infinity, to: 0, fill: ZONE_DOWN },
      ],
    });
  }
  chart.setData(rows);
}

async function fetchData() {
  try {
    const data = await getJson('/api/sentiment');
    if (!data.success || !data.data?.length) { setFreshness(null); return; }
    const rows = data.data.slice().sort((a, b) => a.date.localeCompare(b.date));
    attachScoreSmoothing(rows);
    setFreshness(rows[rows.length - 1].date, { staleAfter: STALE_DAYS, label: 'Read' });
    renderLede(rows);
    renderChart(rows);
  } catch (err) {
    console.error('Fetch error:', err);
    setFreshnessError(err.message);
  }
}

fetchData();
