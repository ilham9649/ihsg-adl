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
const panels = {}; // panel id → BreadthChart (built once, re-fed on every render)

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

// Zweig Breadth Thrust — a 10-day EMA of % Advancing. The signal is the climb
// from an oversold ≤40 reading to ≥61.5 within 10 sessions: a rare sign that a
// bottom was bought by the whole market rather than a few index heavyweights.
// Attaches `zbt` (the EMA) and `thrust` (true on the triggering session).
function attachThrust(rows, span = 10, low = 40, high = 61.5) {
  const alpha = 2 / (span + 1);
  let ema = null, prev = null, lowAt = -1;
  rows.forEach((r, i) => {
    r.thrust = false;
    if (r.pctAdvancing == null) { r.zbt = null; return; }
    ema = ema == null ? r.pctAdvancing : r.pctAdvancing * alpha + ema * (1 - alpha);
    r.zbt = parseFloat(ema.toFixed(2));
    if (ema <= low) lowAt = i;
    if (prev != null && prev < high && ema >= high && lowAt >= 0 && i - lowAt <= span) r.thrust = true;
    prev = ema;
  });
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
    // The reading IS the gap between the two ratios, so chart it directly
    // instead of asking the eye to measure a distance between two lines.
    r.shinSpread = (r.shinWeak != null && r.shinStrong != null)
      ? parseFloat((r.shinWeak - r.shinStrong).toFixed(1)) : null;
  }
}

// ── Palette (paper broadsheet) ──
const GOLD = '#a67a26', SLATE = '#3f5170';
const UP = '#2f6b4f', DOWN = '#b0392c';
const ZONE_UP = 'rgba(47,107,79,0.10)', ZONE_DOWN = 'rgba(176,57,44,0.09)';
// Neutral band: marks a notable region that is neither bullish nor bearish, so
// low readings don't read as "green = buy" on one panel and "red = bad" on another.
const ZONE_FAINT = 'rgba(29,24,19,0.05)';

// ── Cross-chart hover sync ──
// Every panel shares the same filtered data array, so a hovered position maps to
// the same index everywhere. Hovering one chart highlights that date in all the
// others. Subscribers re-register on each renderAll, so we reset the list there.
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
  if (!panels.adline) return;
  const hidden = new Set();
  document.querySelectorAll('#ma-checklist input[type=checkbox]')
    .forEach(cb => { if (!cb.checked) hidden.add(cb.dataset.key); });
  panels.adline.setHidden(hidden);
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
      attachThrust(allData);
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
  renderPanels(data);
  renderTable(data);
}

// ── Chart panels ──
// Every panel is a BreadthChart, so all four share one visual language: same
// axis placement, tick format, tooltip and hover sync.
const PANEL_SPECS = {
  ihsg: { panel: 'price' },

  adline: {
    panel: 'series', field: 'pctAdvancingMA', rawField: 'pctAdvancing',
    label: '% ADVANCING', tipLabel: `${PCT_SMOOTH_WINDOW}-day avg`,
    legendLabel: `${PCT_SMOOTH_WINDOW}d`, ref: 50, unit: '%',
    overlays: [
      { field: 'pctAdvancingMA100', color: GOLD, width: 1.4, label: '100-day', legend: '100d' },
      { field: 'pctAdvancingMA200', color: SLATE, width: 1.6, label: '200-day', legend: '200d' },
    ],
  },

  zbt: {
    // No raw dot-cloud here: the fixed 30–70 window would clip it, and Fig. II
    // already shows the daily scatter.
    panel: 'series', field: 'zbt',
    label: 'ZWEIG THRUST', tipLabel: '10-day EMA', legendLabel: '10d EMA',
    // Reference is 50 (neutral breadth) — colouring against the 61.5 trigger
    // would paint the entire record red, since IDX has never reached it.
    ref: 50, unit: '%', yMin: 20, yMax: 70, markField: 'thrust',
    zones: [
      { from: -Infinity, to: 40, fill: ZONE_FAINT }, // oversold setup
      { from: 61.5, to: Infinity, fill: ZONE_UP },   // the thrust zone
    ],
  },

  stoch: {
    panel: 'series', field: 'stochK',
    label: 'STOCHASTIC', tipLabel: '%K', legendLabel: '%K',
    ref: 50, yMin: 0, yMax: 100, tipAd: false,
    overlays: [{ field: 'stochD', color: SLATE, width: 1.6, label: '%D', legend: '%D' }],
    zones: [
      { from: 0, to: 20, fill: ZONE_UP },
      { from: 80, to: 100, fill: ZONE_DOWN },
    ],
  },

  shinohara: {
    panel: 'series', field: 'shinSpread',
    label: 'WEAK − STRONG', tipLabel: 'Weak − Strong', legendLabel: 'weak−strong',
    // Neutral is 0 (the two ratios equal). 100 is the rare oversold threshold,
    // shaded rather than used as the baseline — anchoring the fill there would
    // paint the whole record red.
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

// ── Cards ──
function ordinal(n) {
  const t = n % 100;
  const suffix = (t >= 11 && t <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return n + suffix;
}

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

  // Rank today's reading against every session on record, so the headline
  // figure says whether it is ordinary or extreme.
  const heroPct = document.getElementById('pct-percentile');
  if (heroPct && pa != null) {
    const hist = allData.map(d => d.pctAdvancing).filter(v => v != null);
    const rank = Math.round(hist.filter(v => v < pa).length / hist.length * 100);
    heroPct.textContent = ordinal(rank);
  }

  // Highest thrust reading ever recorded — quoted in the Fig. III standfirst,
  // computed rather than hardcoded so it stays true as the record grows.
  const zbtRecord = document.getElementById('zbt-record');
  if (zbtRecord) {
    const peak = Math.max(...allData.map(d => d.zbt).filter(v => v != null));
    zbtRecord.textContent = peak.toFixed(1) + '%';
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
