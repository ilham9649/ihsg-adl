// ──────────────────────────────────────────────
// Breadth & Momentum — the front page's script.
// Port of frontend/app.js: the indicator maths and the "Who moved it" block
// are carried over unchanged; what changed is the page around them (period
// buttons, sparkline tiles, one legend per figure, a paged table).
// ──────────────────────────────────────────────
import { BreadthChart } from './breadth-chart.js';
import { API_BASE, getJson, setFreshness, setFreshnessError, debounce, sparkline } from './shared.js';
import { renderHeatmap } from './heatmap.js';
import { computeRotation, renderRotation } from './rotation.js';



// Raw daily % Advancing is very noisy (each session is a fresh draw of ~950
// stocks), so the breadth line is smoothed with a trailing moving average.
// Computed over the FULL series (not the sliced range) so the visible window has
// no warmup gap. Tune the window here.
const PCT_SMOOTH_WINDOW = 20;
// Moving averages of % Advancing drawn on the breadth line (data field → window).
const PCT_MAS = { pctAdvancingMA: 20, pctAdvancingMA100: 100, pctAdvancingMA200: 200 };


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
// Attaches `zbt` (the EMA), `thrust` (Zweig's 61.5 trigger) and `idxThrust`
// (the Jakarta rule: same climb, to 56). 56 came from a 2010–2026 backtest; see
// CLAUDE.md for why it is a watch level, not a proven signal.
const THRUST_RULES = { thrust: 61.5, idxThrust: 56 };
function attachThrust(rows, span = 10, low = 40) {
  const alpha = 2 / (span + 1);
  let ema = null, prev = null, lowAt = -1;
  rows.forEach((r, i) => {
    for (const f in THRUST_RULES) r[f] = false;
    if (r.pctAdvancing == null) { r.zbt = null; return; }
    ema = ema == null ? r.pctAdvancing : r.pctAdvancing * alpha + ema * (1 - alpha);
    r.zbt = parseFloat(ema.toFixed(2));
    if (ema <= low) lowAt = i;
    for (const [f, high] of Object.entries(THRUST_RULES)) {
      r[f] = prev != null && prev < high && ema >= high && lowAt >= 0 && i - lowAt <= span;
    }
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

// ── Palette ──
const GOLD = '#a67a26', SLATE = '#3f5170', INK = '#1a1714';
const UP = '#2f6b4f', DOWN = '#b0392c';
const ZONE_UP = 'rgba(47,107,79,0.10)';
// Neutral band: marks a notable region that is neither bullish nor bearish.
const ZONE_FAINT = 'rgba(26,23,20,0.055)';

let allData = [];
let range = '252';  // the reading period: trailing sessions, 'ytd', or '0' for all
// The session on show — the latest unless the reader picks another. It drives
// the headline, the tiles, Who moved it, the session map and the rotation.
let session = null;
const panels = {};   // panel id → BreadthChart (built once, re-fed on every render)

// ── Cross-chart hover sync ──
// Every panel shares the same filtered data array, so a hovered position maps to
// the same index everywhere. Subscribers re-register on each renderAll.
const HoverSync = {
  subs: [],
  reset() { this.subs = []; },
  register(sub) { this.subs.push(sub); return sub; },
  emit(i, src) { for (const s of this.subs) if (s !== src) s.show(i); },
  clear(src) { for (const s of this.subs) if (s !== src) s.hide(); },
};
function linkBreadth(bc) {
  const sub = { show: (i) => bc.setHover(i), hide: () => bc.clearHover() };
  HoverSync.register(sub);
  bc.onHover = (i) => HoverSync.emit(i, sub);
  bc.onLeave = () => HoverSync.clear(sub);
}

// ── Init ──
document.querySelectorAll('#period button').forEach(btn => btn.addEventListener('click', () => {
  range = btn.dataset.range;
  document.querySelectorAll('#period button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
  renderAll();
}));
document.getElementById('date-filter').addEventListener('input', debounce(() => { tableLimit = TABLE_PAGE; renderTable(getFilteredData()); }));
document.getElementById('record-more').addEventListener('click', () => { tableLimit = Infinity; renderTable(getFilteredData()); });
document.querySelectorAll('.figure-legend input[type=checkbox]').forEach(cb => cb.addEventListener('change', applyMaToggles));
document.getElementById('session-prev').addEventListener('click', () => stepSession(-1));
document.getElementById('session-next').addEventListener('click', () => stepSession(1));
document.getElementById('session-day').addEventListener('change', e => pickSession(e.target.value));
document.getElementById('session-latest').addEventListener('click', () => setSession(allData[allData.length - 1].date));
document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => setMoversView(btn.dataset.view)));
document.getElementById('movers-mode-day').addEventListener('click', () => setMoversMode('day'));
document.getElementById('movers-mode-range').addEventListener('click', () => setMoversMode('range'));
document.getElementById('movers-more').addEventListener('click', toggleMoversLimit);
for (const id of ['movers-from', 'movers-to']) document.getElementById(id).addEventListener('change', loadRange);
// The two fetches start at the foot of the file, once every binding exists.

// Show/hide breadth lines from the legend chips (unchecked → hidden key).
function applyMaToggles() {
  if (!panels.adline) return;
  const hidden = new Set();
  document.querySelectorAll('.figure-legend input[type=checkbox]')
    .forEach(cb => { if (!cb.checked) hidden.add(cb.dataset.key); });
  panels.adline.setHidden(hidden);
}

// ── Fetch ──
async function fetchData() {
  try {
    const data = await getJson('/api/ad');
    if (!data.success || !data.data?.length) { setFreshness(null); return; }
    allData = data.data;
    attachPctSmoothing(allData);
    attachThrust(allData);
    attachStochastic(allData);
    attachShinohara(allData);
    setFreshness(allData[allData.length - 1].date);
    session = allData[allData.length - 1].date;
    const day = document.getElementById('session-day');
    day.min = allData[0].date;
    day.max = session;
    renderAll();
    syncSession();
  } catch (err) {
    console.error('Fetch error:', err);
    setFreshnessError(err.message);
  }
}

function getFilteredData() {
  if (range === 'ytd') {
    // Anchor YTD to the newest session's year, not the browser's local year.
    const latestYear = allData.length ? allData[allData.length - 1].date.slice(0, 4) : new Date().getFullYear();
    return allData.filter(d => d.date >= latestYear + '-01-01');
  }
  const n = parseInt(range, 10);
  return n ? allData.slice(-n) : allData;
}

function renderAll() {
  const data = getFilteredData();
  shownData = data;
  HoverSync.reset();
  renderCards();
  renderPanels(data);
  linkMovers(data);
  renderTable(data);
}

// ── Chart panels ──
// The page draws each legend once, in the figure head, so the canvases don't.
const PANEL_SPECS = {
  ihsg: { panel: 'price', legend: false },

  adline: {
    panel: 'series', field: 'pctAdvancingMA', rawField: 'pctAdvancing', legend: false,
    label: '% ADVANCING', tipLabel: `${PCT_SMOOTH_WINDOW}-day avg`, ref: 50, unit: '%',
    overlays: [
      { field: 'pctAdvancingMA100', color: GOLD, width: 1.4, label: '100-day' },
      { field: 'pctAdvancingMA200', color: SLATE, width: 1.6, label: '200-day' },
    ],
  },

  zbt: {
    panel: 'series', field: 'zbt', legend: false,
    label: 'ZWEIG THRUST', tipLabel: '10-day EMA',
    ref: 50, unit: '%', yMin: 20, yMax: 70, markField: 'idxThrust',
    zones: [
      { from: -Infinity, to: 40, fill: ZONE_FAINT },                 // oversold setup
      { from: THRUST_RULES.idxThrust, to: Infinity, fill: ZONE_UP }, // Jakarta rule
      { from: THRUST_RULES.thrust, to: Infinity, fill: ZONE_UP },    // Zweig's bar, stacks darker
    ],
  },

  // Neutral bands and plain lines: the reading is where the lines sit against
  // 20 and 80, and a red/green split at 50 on top of the bands only muddied it.
  stoch: {
    panel: 'series', field: 'stochK', legend: false, area: false, lineColor: INK,
    label: 'STOCHASTIC', tipLabel: '%K',
    ref: 50, yMin: 0, yMax: 100, tipAd: false,
    overlays: [{ field: 'stochD', color: SLATE, width: 1.6, label: '%D' }],
    zones: [
      { from: 0, to: 20, fill: ZONE_FAINT },
      { from: 80, to: 100, fill: ZONE_FAINT },
    ],
  },

  shinohara: {
    panel: 'series', field: 'shinSpread', legend: false,
    label: 'WEAK − STRONG', tipLabel: 'Weak − Strong',
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
    panels[id].setPinned(data.findIndex(d => d.date === session));
    panels[id].onPick = i => { if (data[i]) setSession(data[i].date); };
    linkBreadth(panels[id]);
  }
  applyMaToggles();
}

// ── Who moved it (Fig. I) ──
// Each session's IHSG move attributed to its constituents, in index points.
// Unlike every other figure on this page this is computed by the backend
// (scrapers/movers.js): it needs share counts and free floats the browser
// doesn't have. Fetched on its own, so the page never waits on it and the
// block simply stays hidden if it isn't there.
let movers = [];             // oldest first — each session's top five
let moversByDate = new Map();
let moverDate = null;        // the session on show in day mode
let moversMode = 'day';      // 'day' | 'range'
let rangeRequest = 0;        // only the latest range request may render
// Five a side by default; "Show 20" expands. The page's own data holds each
// session's top five only (`_movers` would pass DynamoDB's 400KB item limit at
// twenty), so an expanded day is read from the per-day endpoint, which has
// every stock: GET /api/movers/{date}/{date}.
const MOVERS_SHORT = 5, MOVERS_LONG = 20;
let moversLimit = MOVERS_SHORT;
let lastMovers = null;       // the view on show, re-cut when the limit changes
const fullDays = new Map();  // date → that session's top twenty, fetched once
let dayRequest = 0;         // only the latest expanded-day request may render

const fmtPts = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1);
const fmtPct = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%';
const longDate = ds => new Date(ds + 'T00:00:00Z').toLocaleDateString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDate = (ds, withYear = true) => new Date(ds + 'T00:00:00Z').toLocaleDateString('en-GB',
  { day: 'numeric', month: 'short', ...(withYear && { year: 'numeric' }), timeZone: 'UTC' });
// "1 Oct – 28 Oct 2026": the year once when both ends share it.
const spanTitle = (from, to) => `${shortDate(from, from.slice(0, 4) !== to.slice(0, 4))} – ${shortDate(to)}`;

async function fetchMovers() {
  try {
    const res = await fetch(`${API_BASE}/api/movers`);
    const json = await res.json();
    const payload = json.body && json.statusCode ? JSON.parse(json.body) : json;
    if (!payload.success || !payload.data?.length) return;
    movers = payload.data.slice().sort((a, b) => a.date.localeCompare(b.date));
    moversByDate = new Map(movers.map(d => [d.date, d]));
    document.getElementById('movers-float-asof').textContent =
      payload.floatAsOf ? `as of ${payload.floatAsOf}` : 'date unknown';
    // The pickers offer only what is on record.
    for (const id of ['movers-from', 'movers-to']) {
      const input = document.getElementById(id);
      input.min = movers[0].date;
      input.max = movers[movers.length - 1].date;
    }
    document.getElementById('movers').hidden = false;
    showMovers(session || movers[movers.length - 1].date);
    renderRotationFig();
  } catch (err) {
    console.error('Movers fetch error:', err);
  }
}

// In day mode, follows the hover on any panel, and stays on the last session
// hovered when the pointer leaves — moving down to read the list must not snap
// it back. A range the reader typed in is never overridden by a stray hover.
function linkMovers(data) {
  // A hover previews that session's points; leaving goes back to the session on show.
  HoverSync.register({
    show: (i) => { if (moversMode === 'day' && moversView === 'points' && data[i]) showMovers(data[i].date); },
    hide: () => { if (moversMode === 'day' && moversView === 'points' && session) showMovers(session); },
  });
}

// ── The session on show ──
// One date drives the headline, the tiles, Who moved it, the session map and
// the rotation; the charts mark it. A weekend or holiday picked in the
// calendar reads the session before it, and says so.
let shownData = [];       // the rows the charts are drawn from (the period)
let sessionData = null;   // /api/session/{date} for the session on show
const sessionCache = new Map();
let sessionRequest = 0;

function setSession(date, note = '') {
  if (!date) return;
  session = date;
  renderCards();
  const i = shownData.findIndex(d => d.date === session);
  for (const p of Object.values(panels)) p.setPinned(i);
  syncSession(note);
}

function syncSession(note = '') {
  const i = allData.findIndex(d => d.date === session);
  document.getElementById('session-day').value = session;
  document.getElementById('session-prev').disabled = i <= 0;
  document.getElementById('session-next').disabled = i >= allData.length - 1;
  document.getElementById('session-latest').hidden = i === allData.length - 1;
  if (moversMode === 'day' && moversView === 'points') showMovers(session, { force: true, note });
  renderRotationFig();
  loadSession(session);
}

function stepSession(dir) {
  const i = allData.findIndex(d => d.date === session);
  const target = allData[i + dir];
  if (target) setSession(target.date);
}

function pickSession(value) {
  if (!value) return;
  let found = null;
  for (const d of allData) if (d.date <= value) found = d.date;
  if (!found) { setSession(allData[0].date, 'The record starts here.'); return; }
  setSession(found, found === value ? '' : `No trading on ${longDate(value)}; showing the session before.`);
}

async function loadSession(date) {
  const request = ++sessionRequest;
  let data = sessionCache.get(date);
  if (data === undefined) {
    try {
      data = await getJson(`/api/session/${date}`);
      if (!data.success) data = null;
    } catch (err) {
      console.error('Session fetch error:', err);
      data = null;
    }
    sessionCache.set(date, data);
  }
  if (request !== sessionRequest) return; // a newer pick won
  sessionData = data;
  renderHeatmapFig();
  if (moversView !== 'points' && moversMode === 'day') renderTopView();
}

// ── Fig. II: the session map ──
const pctText = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%';
function renderHeatmapFig() {
  const svg = document.getElementById('heatmap');
  const label = document.getElementById('hm-label');
  const readout = document.getElementById('hm-readout');
  const stocks = sessionData?.stocks || [];
  const withWeight = stocks.filter(s => s[3] > 0);
  if (!withWeight.length) {
    svg.replaceChildren();
    svg.style.height = '0';
    label.textContent = longDate(session);
    readout.textContent = sessionData
      ? 'No index weights on record for this session yet — the map fills in from the next refresh.'
      : 'No session map for this date. It covers the last year of sessions.';
    return;
  }
  svg.style.height = '';
  const rest = () => {
    label.textContent = longDate(session);
    readout.textContent = `${withWeight.length} index stocks. Hover or tap a block.`;
  };
  // Drawn in real pixels, so the labels keep their size on any screen; a
  // phone gets a taller box rather than a squashed one.
  const width = Math.round(svg.getBoundingClientRect().width || 1000);
  const height = width < 600 ? Math.round(width * 1.45) : Math.round(Math.min(580, width * 0.5));
  svg.style.height = height + 'px';
  renderHeatmap(svg, stocks, {
    width, height,
    onHover: it => {
      if (!it) return rest();
      label.textContent = it.ticker;
      readout.textContent = `${it.sector} · ${pctText(it.pct)} · ${it.pts >= 0 ? '+' : '−'}${Math.abs(it.pts).toFixed(2)} pts · ${(it.value / 100).toFixed(2)}% of the index`;
    },
  });
  document.getElementById('hm-alt').textContent =
    `Treemap of ${withWeight.length} index stocks for ${longDate(session)}, sized by index weight and coloured by price move, grouped by sector.`;
  rest();
}

// ── Fig. III: sector rotation ──
function renderRotationFig() {
  if (!movers.length || !session) return;
  const svg = document.getElementById('rotation');
  const label = document.getElementById('rot-label');
  const readout = document.getElementById('rot-readout');
  const series = computeRotation(movers.filter(d => d.date <= session));
  const legendEl = document.getElementById('rot-legend');
  if (!series.length) {
    svg.replaceChildren();
    svg.style.display = 'none';
    legendEl.replaceChildren();
    label.textContent = 'Sectors';
    readout.textContent = 'No sector data on record yet. It appears after the nightly valuation job has filed sectors and the next breadth refresh has run.';
    return;
  }
  svg.style.display = '';
  const rest = () => { label.textContent = `Week to ${longDate(session)}`; readout.textContent = 'Hover or tap a sector.'; };
  const width = Math.round(svg.getBoundingClientRect().width || 1000);
  const height = Math.round(width < 600 ? width * 0.95 : width * 0.56);
  svg.style.height = height + 'px';
  const legend = renderRotation(svg, series, {
    width, height,
    onHover: it => {
      if (!it) return rest();
      label.textContent = it.quadrant;
      readout.textContent = `${it.sector} · strength ${it.ratio.toFixed(1)} · momentum ${it.mom.toFixed(1)} · ${(it.weightBp / 100).toFixed(1)}% of the index`;
    },
  });
  legendEl.replaceChildren(...legend.map(l => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = l.color;
    const b = document.createElement('b');
    b.textContent = l.sector;
    li.append(dot, b, ` ${l.quadrant}`);
    return li;
  }));
  document.getElementById('rot-alt').textContent =
    `Relative rotation of ${legend.length} sectors against the index: ` + legend.map(l => `${l.sector} ${l.quadrant}`).join(', ') + '.';
  rest();
}

// ── Who moved it: price and activity views ──
// Points rank who moved the INDEX; these rank the whole listing by its own
// numbers, from the session's top lists (backend/scrapers/toplists.js).
let moversView = 'points'; // 'points' | 'price' | 'activity'
const HEADS = {
  points: ['Lifted the index · points', 'Dragged it · points'],
  price: ['Top gainers · price %', 'Top losers · price %'],
  activity: ['Most traded · value, ≈Rp', 'Most traded · volume, shares'],
};
const compact = v => {
  const a = Math.abs(v);
  return a >= 1e12 ? (v / 1e12).toFixed(2) + 'T' : a >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : String(Math.round(v));
};

function setMoversView(view) {
  if (moversMode === 'range' && view !== 'points') return; // one session only
  moversView = view;
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  document.getElementById('movers-head-up').textContent = HEADS[view][0];
  document.getElementById('movers-head-down').textContent = HEADS[view][1];
  document.querySelector('.movers-cols').classList.toggle('neutral', view === 'activity');
  if (view !== 'points') renderTopView();
  else if (moversMode === 'day') showMovers(session, { force: true });
  else if (lastMovers) renderMovers(lastMovers);
}

// One row of a price/activity list: code, a bar against the list's largest,
// the figure, and a side figure.
function topItem(code, frac, main, side, title) {
  const li = document.createElement('li');
  li.title = title;
  const span = (cls, text) => { const el = document.createElement('span'); el.className = cls; if (text != null) el.textContent = text; return el; };
  const bar = span('mv-bar');
  const fill = document.createElement('i');
  fill.style.width = (frac * 100).toFixed(1) + '%';
  bar.appendChild(fill);
  li.append(span('mv-code', code), bar, span('mv-pts', main), span('mv-pct', side));
  return li;
}

function renderTopView() {
  const top = sessionData?.top;
  const day = moversByDate.get(session);
  document.getElementById('movers-date').textContent = longDate(session);
  const move = document.getElementById('movers-move');
  if (day) {
    move.textContent = `IHSG ${fmtPts(day.change)} pts (${fmtPct(day.pct)})`;
    move.className = 'movers-move ' + (day.change >= 0 ? 'up' : 'down');
  } else move.textContent = '';
  const more = document.getElementById('movers-more');
  if (!top) {
    fillMovers('movers-up', [], 1, '—');
    fillMovers('movers-down', [], 1, '—');
    more.hidden = true;
    document.getElementById('movers-foot').textContent = !sessionCache.has(session)
      ? 'Loading the session…'
      : 'No price lists on record for this session — they cover the last year of sessions.';
    return;
  }
  const n = moversLimit;
  const [left, right] = moversView === 'price' ? [top.gain, top.lose] : [top.value, top.volume];
  // Row: [ticker, close, pct, value, volume]
  const fill = (id, rows, metric, main, side) => {
    const list = rows.slice(0, n);
    const scale = Math.max(...list.map(r => Math.abs(metric(r))), 0) || 1;
    const el = document.getElementById(id);
    if (!list.length) { fillMovers(id, [], 1, 'None this session.'); return; }
    el.replaceChildren(...list.map(r => topItem(r[0], Math.abs(metric(r)) / scale, main(r), side(r),
      `${r[0]} closed at ${r[1].toLocaleString('en-US')}, ${pctText(r[2])}; ≈Rp ${compact(r[3])} traded, ${compact(r[4])} shares`)));
  };
  if (moversView === 'price') {
    fill('movers-up', left, r => r[2], r => pctText(r[2]), r => r[1].toLocaleString('en-US'));
    fill('movers-down', right, r => r[2], r => pctText(r[2]), r => r[1].toLocaleString('en-US'));
  } else {
    fill('movers-up', left, r => r[3], r => compact(r[3]), r => pctText(r[2]));
    fill('movers-down', right, r => r[4], r => compact(r[4]), r => pctText(r[2]));
  }
  more.hidden = Math.max(left.length, right.length) <= MOVERS_SHORT && moversLimit === MOVERS_SHORT;
  more.textContent = moversLimit === MOVERS_SHORT ? `Show ${MOVERS_LONG}` : `Show ${MOVERS_SHORT}`;
  document.getElementById('movers-foot').textContent = moversView === 'price'
    ? 'Across the whole listing, not just index weight: a small stock at its daily limit tops this list while barely touching the IHSG.'
    : "Value is close × volume, an approximation — IDX's own figure prices each trade.";
}

function moverItem(m, scale) {
  const li = document.createElement('li');
  li.title = `${m.ticker} moved ${fmtPct(m.pct)}, worth ${fmtPts(m.pts)} index points`;
  const span = (cls, text) => {
    const el = document.createElement('span');
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  const bar = span('mv-bar');
  const fill = document.createElement('i');
  fill.style.width = (Math.abs(m.pts) / scale * 100).toFixed(1) + '%';
  bar.appendChild(fill);
  li.append(span('mv-code', m.ticker), bar, span('mv-pts', fmtPts(m.pts)), span('mv-pct', fmtPct(m.pct)));
  return li;
}

// Built from DOM nodes, never innerHTML — the codes come from the backend.
function fillMovers(listId, rows, scale, emptyText) {
  const list = document.getElementById(listId);
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'movers-empty';
    li.textContent = emptyText;
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...rows.map(m => moverItem(m, scale)));
}

// One renderer for a session and a range: the title, the IHSG's real move,
// the lifters and draggers, and the line that keeps the estimate honest.
function renderMovers(view) {
  lastMovers = view;
  const { title, change, pct, estimate, counted, note = '' } = view;
  const up = view.up.slice(0, moversLimit);
  const down = view.down.slice(0, moversLimit);
  // Whatever isn't listed is "the other stocks" — including names the server
  // sent but the short list hides — so the net is recomputed from what shows.
  const rest = estimate - up.concat(down).reduce((sum, m) => sum + m.pts, 0);
  const more = document.getElementById('movers-more');
  more.hidden = Math.max(view.up.length, view.down.length) <= MOVERS_SHORT && moversLimit === MOVERS_SHORT && !view.short;
  more.textContent = moversLimit === MOVERS_SHORT ? `Show ${MOVERS_LONG}` : `Show ${MOVERS_SHORT}`;
  document.getElementById('movers-date').textContent = title;
  const move = document.getElementById('movers-move');
  move.textContent = `IHSG ${fmtPts(change)} pts (${fmtPct(pct)})`;
  move.className = 'movers-move ' + (change >= 0 ? 'up' : 'down');
  const scale = Math.max(...up.concat(down).map(m => Math.abs(m.pts)), 0) || 1;
  fillMovers('movers-up', up, scale, 'Nothing lifted it.');
  fillMovers('movers-down', down, scale, 'Nothing dragged it.');
  const others = counted - up.length - down.length;
  document.getElementById('movers-foot').textContent = (note ? note + ' ' : '') +
    `The other ${others.toLocaleString('en-US')} stocks, net: ${fmtPts(rest)} pts. ` +
    `All together these weights come to ${fmtPts(estimate)}, against the real ${fmtPts(change)}.`;
}

function renderMoversEmpty(title, message) {
  lastMovers = null;
  document.getElementById('movers-more').hidden = true;
  document.getElementById('movers-date').textContent = title;
  document.getElementById('movers-move').textContent = '';
  fillMovers('movers-up', [], 1, '—');
  fillMovers('movers-down', [], 1, '—');
  document.getElementById('movers-foot').textContent = message;
}

function showMovers(date, { force = false, note = '' } = {}) {
  if (!movers.length || (date === moverDate && !force)) return;
  moverDate = date;

  const day = moversByDate.get(date);
  if (!day) {
    renderMoversEmpty(longDate(date), date < movers[0].date
      ? `No attribution this far back: it covers the last ${movers.length} sessions, from ${longDate(movers[0].date)}.`
      : 'No attribution on record for this session.');
    return;
  }
  // `short`: this view holds only the stored top five — the toggle stays
  // offered, since an expanded day is fetched rather than sliced.
  renderMovers({ ...day, title: longDate(date), note, short: true });
  if (moversLimit === MOVERS_LONG) loadFullDay(date, note);
}

// The expanded day: its top twenty from the per-day endpoint, cached per date.
// The short list stays on screen until it arrives, and a pause before fetching
// keeps a hover sweep across the chart from firing a request per candle.
async function loadFullDay(date, note) {
  const request = ++dayRequest;
  let view = fullDays.get(date);
  if (!view) {
    await new Promise(r => setTimeout(r, 200));
    if (request !== dayRequest) return;
    try {
      const res = await fetch(`${API_BASE}/api/movers/${date}/${date}`);
      const json = await res.json();
      const payload = json.body && json.statusCode ? JSON.parse(json.body) : json;
      if (!payload.success) return;
      view = payload;
      fullDays.set(date, view);
    } catch (err) {
      console.error('Movers day error:', err);
      return;
    }
  }
  if (request !== dayRequest || moversMode !== 'day' || moverDate !== date || moversLimit !== MOVERS_LONG) return;
  renderMovers({ ...view, title: longDate(date), note });
}

function toggleMoversLimit() {
  moversLimit = moversLimit === MOVERS_SHORT ? MOVERS_LONG : MOVERS_SHORT;
  if (moversView !== 'points') renderTopView();
  else if (moversMode === 'day') showMovers(moverDate, { force: true });
  else if (lastMovers) renderMovers(lastMovers);
}

function setMoversMode(mode) {
  if (!movers.length || mode === moversMode) return;
  // Price and activity are one session's lists; a range ranks by points only.
  if (mode === 'range' && moversView !== 'points') setMoversView('points');
  moversMode = mode;
  document.querySelectorAll('[data-view]').forEach(b => { if (b.dataset.view !== 'points') b.disabled = mode === 'range'; });
  for (const m of ['day', 'range']) {
    const tab = document.getElementById(`movers-mode-${m}`);
    tab.classList.toggle('is-active', m === mode);
    tab.setAttribute('aria-pressed', String(m === mode));
    document.getElementById(`movers-pick-${m}`).hidden = m !== mode;
  }
  if (mode === 'day') {
    showMovers(session || movers[movers.length - 1].date, { force: true });
    return;
  }
  // First visit: the last twenty sessions, about a month.
  const from = document.getElementById('movers-from');
  const to = document.getElementById('movers-to');
  if (!to.value) to.value = movers[movers.length - 1].date;
  if (!from.value) from.value = movers[Math.max(0, movers.length - 20)].date;
  loadRange();
}

// A range is summed on the server: it needs every stock's points on every
// session, which is far more than the page holds (GET /api/movers/{from}/{to}).
async function loadRange() {
  const a = document.getElementById('movers-from').value;
  const b = document.getElementById('movers-to').value;
  if (!a || !b) return;
  const [from, to] = a <= b ? [a, b] : [b, a];
  const request = ++rangeRequest;
  const title = spanTitle(from, to);
  renderMoversEmpty(title, 'Adding up the range…');
  try {
    const res = await fetch(`${API_BASE}/api/movers/${from}/${to}`);
    const json = await res.json();
    const payload = json.body && json.statusCode ? JSON.parse(json.body) : json;
    if (request !== rangeRequest || moversMode !== 'range') return; // a newer pick won
    if (!payload.success) {
      renderMoversEmpty(title, payload.message || payload.error || 'No sessions on record in that range.');
      return;
    }
    const n = payload.sessions;
    renderMovers({ ...payload, title: `${spanTitle(payload.from, payload.to)} · ${n} session${n === 1 ? '' : 's'}` });
  } catch (err) {
    console.error('Movers range error:', err);
    if (request === rangeRequest) renderMoversEmpty(title, 'Could not load that range.');
  }
}

// ── Headline and tiles ──
function ordinal(n) {
  const t = n % 100;
  const suffix = (t >= 11 && t <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return n + suffix;
}

// The headline always reads the latest session, whatever the period.
function renderCards() {
  if (!allData.length) return;
  const at = Math.max(0, allData.findIndex(d => d.date === session));
  const latest = allData[at] || allData[allData.length - 1];
  const pa = latest.pctAdvancing;
  document.getElementById('hero-date').textContent = longDate(latest.date);
  if (pa != null) {
    const broad = pa >= 50;
    const heroNum = document.getElementById('pct-advancing');
    heroNum.textContent = pa.toFixed(1) + '%';
    heroNum.style.color = broad ? UP : DOWN;
    const verdict = document.getElementById('pct-verdict');
    verdict.textContent = broad ? 'A broad advance' : 'A narrowing market';
    verdict.style.color = broad ? UP : DOWN;
    const hist = allData.map(d => d.pctAdvancing).filter(v => v != null);
    document.getElementById('pct-percentile').textContent = ordinal(Math.round(hist.filter(v => v < pa).length / hist.length * 100));
  }
  if (latest.pctAdvancingMA != null) document.getElementById('pct-advancing-ma').textContent = latest.pctAdvancingMA.toFixed(1) + '%';

  // Fig. III figures — computed, never hardcoded.
  const peak = Math.max(...allData.map(d => d.zbt).filter(v => v != null));
  document.getElementById('zbt-record').textContent = peak.toFixed(1) + '%';
  const hits = allData.filter(d => d.thrust);
  const years = [...new Set(hits.map(d => d.date.slice(0, 4)))].join(' and ');
  document.getElementById('zbt-count').textContent = hits.length === 0 ? 'not once'
    : hits.length === 1 ? `once, in ${years}`
    : hits.length === 2 ? `twice, both in ${years}`
    : `${hits.length} times, in ${years}`;
  // Jakarta rule: count episodes (≥63 sessions apart) and compare the IHSG's
  // six-month return after each with an ordinary day's.
  const H = 126;
  const fwd = i => i + H < allData.length && allData[i].ihsg && allData[i + H].ihsg ? allData[i + H].ihsg / allData[i].ihsg - 1 : null;
  const mean = v => v.reduce((a, b) => a + b, 0) / v.length;
  const idx = allData.map((d, i) => d.idxThrust ? i : -1).filter(i => i >= 0);
  const episodes = idx.filter((i, k) => k === 0 || i - idx[k - 1] > 63);
  const after = episodes.map(fwd).filter(v => v != null);
  const base = allData.map((_, i) => fwd(i)).filter(v => v != null);
  const pct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
  document.getElementById('idx-count').textContent = `${episodes.length} episodes`;
  document.getElementById('idx-after').textContent = after.length ? pct(mean(after)) : '—';
  document.getElementById('idx-base').textContent = base.length ? pct(mean(base)) : '—';

  document.getElementById('universe-count').textContent = latest.advances + latest.declines + latest.unchanged;

  // Tiles: the latest value, and its last 30 sessions as a sparkline.
  const recent = allData.slice(Math.max(0, at - 29), at + 1);
  const tiles = [
    ['advances', latest.advances, null, d => d.advances, 'up'],
    ['declines', latest.declines, null, d => d.declines, 'down'],
    ['unchanged', latest.unchanged, null, d => d.unchanged, ''],
    ['ratio', latest.ratio.toFixed(2), 1, d => d.ratio, latest.ratio >= 1 ? 'up' : 'down'],
    ['spread', (latest.spread >= 0 ? '+' : '') + latest.spread, 0, d => d.spread, latest.spread >= 0 ? 'up' : 'down'],
    ['mcclellan', (latest.mcClellan >= 0 ? '+' : '') + latest.mcClellan.toFixed(1), 0, d => d.mcClellan, latest.mcClellan >= 0 ? 'up' : 'down'],
  ];
  for (const [id, text, ref, get, tone] of tiles) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = 'tile-value ' + tone;
    sparkline(document.getElementById(id + '-spark'), recent.map(get), { ref });
  }
}

// ── The daily record ──
const num = (v, dp = 1) => v == null ? '—' : v.toFixed(dp);
const signed = (v, dp = 0) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(dp);
const above = (ref) => (v) => v == null ? null : (v >= ref ? 'td-positive' : 'td-negative');

// Columns in groups, so sixteen of them read as four questions.
const TABLE_GROUPS = [
  { head: '', cols: [
    { key: 'date', head: 'Date', desc: 'Trading session', get: d => d.date, num: false },
    { key: 'ihsg', head: 'IHSG', desc: 'Index close', get: d => d.ihsg == null ? '—' : Math.round(d.ihsg).toLocaleString('en-US') },
  ] },
  { head: 'The count', cols: [
    { key: 'advances', head: 'Adv', desc: 'Companies that closed higher', get: d => d.advances, cls: () => 'td-positive' },
    { key: 'declines', head: 'Dec', desc: 'Companies that closed lower', get: d => d.declines, cls: () => 'td-negative' },
    { key: 'unchanged', head: 'Unch', desc: 'Closed flat, or did not trade', get: d => d.unchanged },
    { key: 'spread', head: 'Spread', desc: 'Advances minus declines', get: d => signed(d.spread), cls: d => above(0)(d.spread) },
    { key: 'ratio', head: 'Ratio', desc: 'Advances per decline; 1.00 is even', get: d => num(d.ratio, 2), cls: d => above(1)(d.ratio) },
  ] },
  { head: 'Breadth', cols: [
    { key: 'pctAdvancing', head: '% Adv', desc: 'Share of trading companies that rose; 50% is neutral', get: d => d.pctAdvancing == null ? '—' : num(d.pctAdvancing) + '%', cls: d => above(50)(d.pctAdvancing) },
    { key: 'pctAdvancingMA', head: '20d', desc: '20-day average of % Advancing', get: d => num(d.pctAdvancingMA), cls: d => above(50)(d.pctAdvancingMA) },
    { key: 'pctAdvancingMA100', head: '100d', desc: '100-day average of % Advancing', get: d => num(d.pctAdvancingMA100), cls: d => above(50)(d.pctAdvancingMA100) },
    { key: 'pctAdvancingMA200', head: '200d', desc: '200-day average of % Advancing', get: d => num(d.pctAdvancingMA200), cls: d => above(50)(d.pctAdvancingMA200) },
    { key: 'zbt', head: 'ZBT', desc: 'Zweig Breadth Thrust: 10-day EMA of % Advancing', get: d => num(d.zbt), cls: d => above(50)(d.zbt) },
    { key: 'mcClellan', head: 'McClellan', desc: '19 less 39-day EMA of the spread; 0 is neutral', get: d => signed(d.mcClellan, 1), cls: d => above(0)(d.mcClellan) },
  ] },
  { head: 'Momentum (weekly)', cols: [
    { key: 'stochK', head: '%K', desc: 'Weekly stochastic (15,3,3)', get: d => num(d.stochK), cls: d => above(50)(d.stochK) },
    { key: 'stochD', head: '%D', desc: 'Three-week average of %K', get: d => num(d.stochD), cls: d => above(50)(d.stochD) },
    { key: 'shinSpread', head: 'W−S', desc: 'Shinohara Weak minus Strong; above 100 extremely oversold', get: d => num(d.shinSpread), cls: d => above(0)(d.shinSpread) },
  ] },
];
const TABLE_COLS = TABLE_GROUPS.flatMap((g, gi) => g.cols.map((c, ci) => ({ ...c, groupStart: gi > 0 && ci === 0 })));

const TABLE_PAGE = 50;
let tableLimit = TABLE_PAGE;
let sortKey = 'date';
let sortDir = -1; // most recent session first

function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // blanks last
    return x > y ? sortDir : x < y ? -sortDir : 0;
  });
}

function renderTableHead() {
  const thead = document.querySelector('#data-table thead');
  if (thead.children.length) return;
  const groups = document.createElement('tr');
  groups.className = 'groups';
  for (const g of TABLE_GROUPS) {
    const th = document.createElement('th');
    th.colSpan = g.cols.length;
    th.textContent = g.head;
    groups.appendChild(th);
  }
  const heads = document.createElement('tr');
  for (const c of TABLE_COLS) {
    const th = document.createElement('th');
    if (c.num !== false) th.classList.add('num');
    if (c.groupStart) th.classList.add('group-start');
    th.scope = 'col';
    th.title = `${c.desc} — click to sort`;
    th.dataset.key = c.key;
    th.tabIndex = 0;
    th.textContent = c.head;
    const sort = () => {
      sortDir = sortKey === c.key ? -sortDir : -1;
      sortKey = c.key;
      renderTable(getFilteredData());
    };
    th.addEventListener('click', sort);
    th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } });
    heads.appendChild(th);
  }
  thead.append(groups, heads);
}

function renderTable(data) {
  renderTableHead();
  const query = document.getElementById('date-filter').value.trim();
  // A search reaches the whole record: the period only slices backwards from today.
  const rows = sortRows(query ? allData.filter(d => d.date.includes(query)) : data);
  const shown = rows.slice(0, tableLimit);
  const frag = document.createDocumentFragment();
  for (const d of shown) {
    const tr = document.createElement('tr');
    for (const c of TABLE_COLS) {
      const td = document.createElement('td');
      const cls = c.cls ? c.cls(d) : null;
      if (cls) td.className = cls;
      if (c.num !== false) td.classList.add('num');
      if (c.groupStart) td.classList.add('group-start');
      td.textContent = c.get(d);
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  document.querySelector('#data-table tbody').replaceChildren(frag);
  document.querySelectorAll('#data-table thead th[data-key]').forEach(th => {
    const on = th.dataset.key === sortKey;
    th.dataset.sorted = on ? (sortDir === 1 ? 'asc' : 'desc') : '';
    th.setAttribute('aria-sort', on ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
  });
  const more = document.getElementById('record-more');
  more.hidden = shown.length >= rows.length;
  more.textContent = `Show all ${rows.length.toLocaleString('en-US')} sessions`;
  document.getElementById('record-count').textContent = query
    ? `${rows.length} of ${allData.length.toLocaleString('en-US')} sessions match`
    : `${shown.length.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')} sessions`;
}

// Both SVG figures are drawn at their real size; redraw when that changes.
let lastWidth = window.innerWidth;
window.addEventListener('resize', debounce(() => {
  if (window.innerWidth === lastWidth) return; // a phone's toolbar showing/hiding
  lastWidth = window.innerWidth;
  if (session) { renderHeatmapFig(); renderRotationFig(); }
}, 250));

// ── Start ──
fetchData();
fetchMovers();
