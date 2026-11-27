// ──────────────────────────────────────────────
// Market Map — one trading session, or one date range, at a time: what the
// IHSG did, which stocks moved it, the session map, the top lists and sector
// rotation. The toolbar holds the one control for the whole page: One day (the
// ‹ date › navigator, or a click on any candle) or Date range (From / To).
// The breadth indicators live on their own page (breadth.js).
// ──────────────────────────────────────────────
import { BreadthChart } from './breadth-chart.js';
import { API_BASE, getJson, setFreshness, setFreshnessError, debounce } from './shared.js';
import { renderHeatmap } from './heatmap.js';
import { computeRotation, renderRotation } from './rotation.js';
import { HoverSync, linkBreadth } from './sync.js';

// ── Palette ──
const GOLD = '#a67a26', SLATE = '#3f5170', INK = '#1a1714';
const UP = '#2f6b4f', DOWN = '#b0392c';
const ZONE_UP = 'rgba(47,107,79,0.10)';
// Neutral band: marks a notable region that is neither bullish nor bearish.
const ZONE_FAINT = 'rgba(26,23,20,0.055)';


let allData = [];
let session = null; // the session on show — the latest unless the reader picks another
let mode = 'day';   // 'day' | 'range' — the toolbar's toggle, for the whole page
let range = null;   // { from, to, sessions } snapped to trading sessions, in range mode
// The date the charts mark and the rotation runs to: the session, or the range's end.
const anchor = () => (mode === 'range' && range ? range.to : session);
const panels = {};
// The candles cover the movers' trailing year: every session in them can be read.
const MAP_SESSIONS = 252;

// ── Init ──
document.getElementById('session-prev').addEventListener('click', () => stepSession(-1));
document.getElementById('session-next').addEventListener('click', () => stepSession(1));
document.getElementById('session-day').addEventListener('change', e => pickSession(e.target.value));
document.getElementById('session-latest').addEventListener('click', () => setSession(allData[allData.length - 1].date));
document.getElementById('mode-day').addEventListener('click', () => setMode('day'));
document.getElementById('mode-range').addEventListener('click', () => setMode('range'));
for (const id of ['range-from', 'range-to']) document.getElementById(id).addEventListener('change', pickRange);
document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => setMoversView(btn.dataset.view)));
document.getElementById('movers-more').addEventListener('click', toggleMoversLimit);

// ── Fetch ──
async function fetchData() {
  try {
    const data = await getJson('/api/ad');
    if (!data.success || !data.data?.length) { setFreshness(null); return; }
    allData = data.data;
    setFreshness(allData[allData.length - 1].date);
    session = allData[allData.length - 1].date;
    // The pickers offer only the year the page can read.
    for (const id of ['session-day', 'range-from', 'range-to']) {
      const input = document.getElementById(id);
      input.min = allData[Math.max(0, allData.length - MAP_SESSIONS)].date;
      input.max = session;
    }
    renderAll();
    syncSession();
  } catch (err) {
    console.error('Fetch error:', err);
    setFreshnessError(err.message);
  }
}

function renderAll() {
  const data = allData.slice(-MAP_SESSIONS);
  shownData = data;
  HoverSync.reset();
  renderHero();
  renderPanels(data);
  linkMovers(data);
}

// ── The candles ──
function renderPanels(data) {
  const canvas = document.getElementById('ihsg-chart');
  if (!panels.ihsg) panels.ihsg = new BreadthChart(canvas, document.getElementById('ihsg-tip'), { panel: 'price', legend: false });
  panels.ihsg.setData(data);
  panels.ihsg.setPinned(data.findIndex(d => d.date === anchor()));
  panels.ihsg.onPick = i => { if (data[i]) setSession(data[i].date); };
  linkBreadth(panels.ihsg);
}

// ── Headline and tiles: the session's own numbers, or the range's ──
const fmtIdx = v => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const setText = (id, text) => { document.getElementById(id).textContent = text; };
// Who did the most, and how close the estimate came — a session's or a range's.
function heroMovers(up, down, estimate, change, missing) {
  const mover = (id, m) => {
    setText(id, m ? m.ticker : '—');
    setText(id + '-note', m ? `${fmtPts(m.pts)} pts · ${fmtPct(m.pct)}` : missing);
  };
  mover('lifter', up);
  mover('dragger', down);
  setText('estimate', estimate != null ? fmtPts(estimate) : '—');
  setText('estimate-note', estimate != null ? `Our weights, against the real ${fmtPts(change)}` : missing);
}

function renderHero() {
  if (!allData.length || !session) return;
  if (mode === 'range') { renderHeroRange(); return; }
  const at = allData.findIndex(d => d.date === session);
  const row = allData[at], prev = allData[at - 1];
  if (!row) return;
  setText('hero-date', longDate(session));
  const fig = document.getElementById('hero-close');
  fig.textContent = row.ihsg != null ? fmtIdx(row.ihsg) : '—';
  const verdict = document.getElementById('hero-move');
  if (row.ihsg != null && prev?.ihsg) {
    const ch = row.ihsg - prev.ihsg;
    verdict.textContent = `${fmtPts(ch)} pts (${fmtPct(ch / prev.ihsg * 100)})`;
    verdict.style.color = fig.style.color = ch >= 0 ? UP : DOWN;
  } else verdict.textContent = '';
  setText('hero-range-label', "Day's range");
  setText('hero-range', row.ihsgLow != null ? `${fmtIdx(row.ihsgLow)} – ${fmtIdx(row.ihsgHigh)}` : '—');
  setText('hero-pctadv-label', '% Advancing');
  setText('hero-pctadv', row.pctAdvancing != null ? row.pctAdvancing.toFixed(1) + '%' : '—');

  const day = moversByDate.get(session);
  sectorTiles(day ? [day] : []);
  renderWeightTile(sessionCache.get(session)?.stocks, !sessionCache.has(session));
  heroMovers(day?.up?.[0], day?.down?.[0], day?.estimate, day?.change, 'Not on record');
}

// A range: the close it ended on and its move from the close before it, its
// low and high, average % advancing, and the tiles over the whole range.
function renderHeroRange() {
  const rows = allData.filter(d => d.date >= range.from && d.date <= range.to);
  if (!rows.length) return;
  const last = rows[rows.length - 1];
  const prev = allData[allData.indexOf(rows[0]) - 1];
  setText('hero-date', longDate(range.to));
  const fig = document.getElementById('hero-close');
  fig.textContent = last.ihsg != null ? fmtIdx(last.ihsg) : '—';
  const verdict = document.getElementById('hero-move');
  const n = rows.length;
  if (last.ihsg != null && prev?.ihsg) {
    const ch = last.ihsg - prev.ihsg;
    verdict.textContent = `${fmtPts(ch)} pts (${fmtPct(ch / prev.ihsg * 100)}) over ${n} session${n === 1 ? '' : 's'}`;
    verdict.style.color = fig.style.color = ch >= 0 ? UP : DOWN;
  } else verdict.textContent = '';
  const lows = rows.map(d => d.ihsgLow).filter(v => v != null), highs = rows.map(d => d.ihsgHigh).filter(v => v != null);
  setText('hero-range-label', 'Low – high');
  setText('hero-range', lows.length ? `${fmtIdx(Math.min(...lows))} – ${fmtIdx(Math.max(...highs))}` : '—');
  const pa = rows.map(d => d.pctAdvancing).filter(v => v != null);
  setText('hero-pctadv-label', '% Advancing, avg');
  setText('hero-pctadv', pa.length ? (pa.reduce((x, y) => x + y, 0) / pa.length).toFixed(1) + '%' : '—');

  sectorTiles(movers.filter(d => d.date >= range.from && d.date <= range.to));
  renderWeightTile(rangeData?.stocks, rangePending);
  const ranked = rangeRanks();
  heroMovers(ranked?.up[0], ranked?.down[0], rangeData?.estimate, rangeData?.change,
    rangePending ? 'Adding up the range…' : 'Not on record');
}

const MIN_SECTOR_BP = 100;
// Names that would wrap in a tile; the full name stays in its tooltip.
const SHORT_SECTOR = { 'Communication Services': 'Communication', 'Consumer Defensive': 'Cons. Defensive', 'Consumer Cyclical': 'Cons. Cyclical' };
const setTone = (el, tone) => { el.classList.remove('up', 'down'); if (tone) el.classList.add(tone); };

// Best and worst sector over a run of sessions (one, for a day). Ranked by
// the sector's own move, not its points: by points the heaviest sector
// (Financial Services) would top or tail nearly every session. Each session's
// move is pts / (prev close × weight), chained across a range like the
// rotation's sector indices; the weight shown is the one going in. A sector
// under 1% of the index is too thin to name; "Other" is a pool.
function sectorTiles(days) {
  const acc = new Map();
  for (const d of days) {
    const base = d.close - d.change;
    if (!(base > 0)) continue;
    for (const [name, [bp, pts]] of Object.entries(d.sectors || {})) {
      if (name === 'Other' || !(bp > 0)) continue;
      let sec = acc.get(name);
      if (!sec) acc.set(name, sec = { name, bp, pts: 0, growth: 1 });
      sec.pts += pts;
      sec.growth *= 1 + pts / (base * bp / 1e4);
    }
  }
  const sectors = [...acc.values()]
    .filter(sec => sec.bp >= MIN_SECTOR_BP)
    .map(sec => ({ ...sec, pct: (sec.growth - 1) * 100 }))
    .sort((x, y) => y.pct - x.pct);
  const sectorTile = (id, sec) => {
    const el = document.getElementById(id);
    el.textContent = sec ? (SHORT_SECTOR[sec.name] || sec.name) : '—';
    el.title = sec ? sec.name : '';
    setTone(el, sec && (sec.pct >= 0 ? 'up' : 'down'));
    // Two decimals for a quiet sector, so it doesn't read "−0.0".
    const fine = (v, unit) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(Math.abs(v) < 0.1 ? 2 : 1) + unit;
    document.getElementById(id + '-note').textContent = sec
      ? `${fine(sec.pct, '%')} · ${fine(sec.pts, ' pts')} · ${(sec.bp / 100).toFixed(1)}% of the index`
      : 'Not on record';
  };
  sectorTile('topsector', sectors[0]);
  sectorTile('bottomsector', sectors.length > 1 ? sectors[sectors.length - 1] : null);
}

// The cap-weighted counterpart of % Advancing: how much of the index, by
// weight, closed higher (over a range: weight going in, in stocks that ended
// higher). Far from % Advancing, a few heavyweights moved it. Needs every
// index stock's weight, so it fills in once /api/session arrives.
function renderWeightTile(list, pending) {
  const el = document.getElementById('weightup');
  const note = document.getElementById('weightup-note');
  const stocks = (list || []).filter(s => s[3] > 0);
  if (!stocks.length) {
    el.textContent = '—';
    setTone(el, null);
    note.textContent = pending ? 'Loading…' : 'Not on record';
    return;
  }
  const total = stocks.reduce((a, s) => a + s[3], 0);
  const upW = stocks.filter(s => s[2] > 0).reduce((a, s) => a + s[3], 0);
  const share = upW / total * 100;
  el.textContent = share.toFixed(0) + '%';
  setTone(el, share >= 50 ? 'up' : 'down');
  note.textContent = `${stocks.filter(s => s[2] > 0).length} of ${stocks.length} index stocks ${mode === 'range' ? 'ended higher' : 'rose'}`;
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
    document.getElementById('movers').hidden = false;
    if (mode === 'day') showMovers(session || movers[movers.length - 1].date);
    renderRotationFig();
    renderHero();
  } catch (err) {
    console.error('Movers fetch error:', err);
  }
}

// In day mode, a hover on the candles previews that session's points; leaving
// goes back to the session on show. A range is never overridden by a hover.
function linkMovers(data) {
  // A hover previews that session's points; leaving goes back to the session on show.
  HoverSync.register({
    show: (i) => { if (mode === 'day' && moversView === 'points' && data[i]) showMovers(data[i].date); },
    hide: () => { if (mode === 'day' && moversView === 'points' && session) showMovers(session); },
  });
}

// ── The session on show ──
// One date (or one range, below) drives the headline, the tiles, Who moved it,
// the session map and the rotation; the charts mark it. A weekend or holiday
// picked in the calendar reads the session before it, and says so.
let shownData = [];       // the rows the charts are drawn from (the period)
let sessionData = null;   // /api/session/{date} for the session on show
const sessionCache = new Map();
let sessionRequest = 0;

// A click on a candle picks that session, so it also leaves range mode.
function setSession(date, note = '') {
  if (!date) return;
  session = date;
  if (mode === 'range') { setMode('day'); if (note) showMovers(session, { force: true, note }); return; }
  renderHero();
  pinCharts();
  syncSession(note);
}

function pinCharts() {
  const i = shownData.findIndex(d => d.date === anchor());
  for (const p of Object.values(panels)) p.setPinned(i);
}

function syncSession(note = '') {
  const i = allData.findIndex(d => d.date === session);
  document.getElementById('session-day').value = session;
  document.getElementById('session-prev').disabled = i <= 0;
  document.getElementById('session-next').disabled = i >= allData.length - 1;
  document.getElementById('session-latest').hidden = i === allData.length - 1;
  if (moversView === 'points') showMovers(session, { force: true, note });
  else if (moversView === 'foreign') renderForeignView(note);
  else renderTopView();
  renderRotationFig();
  loadSession(session);
  loadForeign();
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
  if (request !== sessionRequest || mode !== 'day') return; // a newer pick won
  sessionData = data;
  renderWeightTile(data?.stocks, false);
  renderHeatmapFig();
  if (moversView === 'price' || moversView === 'activity') renderTopView();
}

// ── The range on show ──
// From / To in the toolbar, snapped to the trading sessions inside them. One
// fetch, GET /api/session/{from}/{to}, carries everything the range needs:
// every index stock's points, move and weight (the map, Who moved it) and the
// top lists across the whole listing.
let rangeData = null;        // the server's answer for the range on show
let rangePending = false;
let rangeMessage = '';       // why there is no answer, when there isn't
const rangeCache = new Map();
let rangeRequest = 0;

function setMode(next) {
  if (next === mode || !allData.length) return;
  mode = next;
  for (const m of ['day', 'range']) document.getElementById(`mode-${m}`).setAttribute('aria-pressed', String(m === mode));
  document.getElementById('nav-day').hidden = mode !== 'day';
  document.getElementById('nav-range').hidden = mode !== 'range';
  if (mode === 'day') {
    renderHero();
    pinCharts();
    syncSession();
    return;
  }
  // First visit: the twenty sessions to the one on show, about a month.
  const from = document.getElementById('range-from'), to = document.getElementById('range-to');
  if (!from.value || !to.value) {
    const at = allData.findIndex(d => d.date === session);
    to.value = session;
    from.value = allData[Math.max(0, at - 19)].date;
  }
  pickRange();
}

function pickRange() {
  let a = document.getElementById('range-from').value, b = document.getElementById('range-to').value;
  if (!a || !b) return;
  if (a > b) [a, b] = [b, a];
  const rows = allData.filter(d => d.date >= a && d.date <= b);
  const note = document.getElementById('range-note');
  if (!rows.length) { note.textContent = 'No trading in that range.'; return; }
  range = { from: rows[0].date, to: rows[rows.length - 1].date, sessions: rows.length };
  note.textContent = `${range.sessions} session${range.sessions === 1 ? '' : 's'}`;
  renderHero();
  pinCharts();
  renderRotationFig();
  loadRange();
  loadForeign();
}

async function loadRange() {
  const { from, to } = range;
  const key = `${from}/${to}`;
  const request = ++rangeRequest;
  rangeData = rangeCache.get(key) || null;
  rangePending = !rangeData;
  rangeMessage = '';
  renderRangeViews();
  if (rangeData) return;
  let payload;
  try {
    payload = await getJson(`/api/session/${from}/${to}`);
  } catch (err) {
    console.error('Range fetch error:', err);
    payload = { success: false, message: 'Could not load that range.' };
  }
  if (request !== rangeRequest) return; // a newer pick won
  rangePending = false;
  if (payload.success) rangeCache.set(key, rangeData = payload);
  else rangeMessage = payload.message || payload.error || 'Nothing on record for that range.';
  if (mode === 'range') renderRangeViews();
}

function renderRangeViews() {
  renderHero();
  renderHeatmapFig();
  renderRangeMovers();
}

// The range's lifters and draggers, from every stock's added-up points.
function rangeRanks() {
  const stocks = rangeData?.stocks;
  if (!stocks?.length) return null;
  const entries = stocks.map(([ticker, pts, pct]) => ({ ticker, pts, pct }));
  const up = entries.filter(e => e.pts > 0).sort((x, y) => y.pts - x.pts).slice(0, MOVERS_LONG);
  const down = entries.filter(e => e.pts < 0).sort((x, y) => x.pts - y.pts).slice(0, MOVERS_LONG);
  return { up, down, counted: entries.length };
}

const rangeTitle = () => `${spanTitle(range.from, range.to)} · ${range.sessions} session${range.sessions === 1 ? '' : 's'}`;

// ── Fig. II: the session map ──
const pctText = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%';
function renderHeatmapFig() {
  const svg = document.getElementById('heatmap');
  const label = document.getElementById('hm-label');
  const readout = document.getElementById('hm-readout');
  const inRange = mode === 'range';
  const source = inRange ? rangeData : sessionData;
  const title = inRange ? spanTitle(range.from, range.to) : longDate(session);
  // A range's moves run wider than a session's, so its colours saturate later.
  const full = inRange ? 15 : 5;
  setText('hm-neg', `−${full}%`);
  setText('hm-pos', `+${full}%`);
  const stocks = source?.stocks || [];
  const withWeight = stocks.filter(s => s[3] > 0);
  if (!withWeight.length) {
    svg.replaceChildren();
    svg.style.height = '0';
    label.textContent = title;
    readout.textContent = inRange
      ? (rangePending ? 'Adding up the range…' : rangeData ? 'No index weights on record for this range.' : rangeMessage)
      : sessionData
        ? 'No index weights on record for this session yet — the map fills in from the next refresh.'
        : 'No session map for this date. It covers the last year of sessions.';
    return;
  }
  svg.style.height = '';
  const rest = () => {
    label.textContent = title;
    readout.textContent = inRange
      ? `${withWeight.length} index stocks, sized by weight going into the range. Hover or tap a block.`
      : `${withWeight.length} index stocks. Hover or tap a block.`;
  };
  // Drawn in real pixels, so the labels keep their size on any screen; a
  // phone gets a taller box rather than a squashed one.
  const width = Math.round(svg.getBoundingClientRect().width || 1000);
  const height = width < 600 ? Math.round(width * 1.45) : Math.round(Math.min(580, width * 0.5));
  svg.style.height = height + 'px';
  renderHeatmap(svg, stocks, {
    width, height, full,
    onHover: it => {
      if (!it) return rest();
      label.textContent = it.ticker;
      readout.textContent = `${it.sector} · ${pctText(it.pct)} · ${it.pts >= 0 ? '+' : '−'}${Math.abs(it.pts).toFixed(2)} pts · ${(it.value / 100).toFixed(2)}% of the index`;
    },
  });
  document.getElementById('hm-alt').textContent =
    `Treemap of ${withWeight.length} index stocks for ${title}, sized by index weight and coloured by price move, grouped by sector.`;
  rest();
}

// ── Fig. III: sector rotation ──
function renderRotationFig() {
  const end = anchor();
  if (!movers.length || !end) return;
  const svg = document.getElementById('rotation');
  const label = document.getElementById('rot-label');
  const readout = document.getElementById('rot-readout');
  const series = computeRotation(movers.filter(d => d.date <= end));
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
  const rest = () => { label.textContent = `Week to ${longDate(end)}`; readout.textContent = 'Hover or tap a sector.'; };
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
// numbers, from the session ledger (backend/scrapers/ledger.js) — for one
// session, or summed over a date range (GET /api/session/{from}/{to}).
let moversView = 'points'; // 'points' | 'price' | 'activity'
const HEADS = {
  points: ['Lifted the index · points', 'Dragged it · points'],
  price: ['Top gainers · price %', 'Top losers · price %'],
  activity: ['Most traded · value, ≈Rp', 'Most traded · volume, shares'],
  foreign: ['Foreign bought · net Rp', 'Foreign sold · net Rp'],
};
const compact = v => {
  const a = Math.abs(v);
  return a >= 1e12 ? (v / 1e12).toFixed(2) + 'T' : a >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : String(Math.round(v));
};

function setMoversView(view) {
  moversView = view;
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  document.getElementById('movers-head-up').textContent = HEADS[view][0];
  document.getElementById('movers-head-down').textContent = HEADS[view][1];
  document.querySelector('.movers-cols').classList.toggle('neutral', view === 'activity');
  if (view === 'foreign') renderForeignView();
  else if (mode === 'range') renderRangeMovers();
  else if (view !== 'points') renderTopView();
  else showMovers(session, { force: true });
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

// The lists on show: one session's (from the session fetch).
function renderTopView() {
  const day = moversByDate.get(session);
  renderTopLists({
    title: longDate(session),
    change: day?.change, pct: day?.pct,
    top: sessionData?.top,
    pending: !sessionCache.has(session),
    missing: 'No price lists on record for this session — they cover the last year of sessions.',
    foot: moversView === 'price'
      ? 'Across the whole listing, not just index weight: a small stock at its daily limit tops this list while barely touching the IHSG.'
      : "Value is close × volume, an approximation — IDX's own figure prices each trade.",
  });
}

function renderTopLists({ title, change, pct, top, pending = false, missing, foot }) {
  document.getElementById('movers-date').textContent = title;
  const move = document.getElementById('movers-move');
  if (change != null) {
    move.textContent = `IHSG ${fmtPts(change)} pts (${fmtPct(pct)})`;
    move.className = 'movers-move ' + (change >= 0 ? 'up' : 'down');
  } else move.textContent = '';
  const more = document.getElementById('movers-more');
  if (!top) {
    fillMovers('movers-up', [], 1, '—');
    fillMovers('movers-down', [], 1, '—');
    more.hidden = true;
    document.getElementById('movers-foot').textContent = pending ? 'Loading the lists…' : missing;
    return;
  }
  const n = moversLimit;
  const [left, right] = moversView === 'price' ? [top.gain, top.lose] : [top.value, top.volume];
  // Row: [ticker, close, pct, value, volume]; pct is null without a live start.
  const pctOr = v => (v == null ? '—' : pctText(v));
  const fill = (id, rows, metric, main, side) => {
    const list = rows.slice(0, n);
    const scale = Math.max(...list.map(r => Math.abs(metric(r))), 0) || 1;
    const el = document.getElementById(id);
    if (!list.length) { fillMovers(id, [], 1, 'None in this span.'); return; }
    el.replaceChildren(...list.map(r => topItem(r[0], Math.abs(metric(r)) / scale, main(r), side(r),
      `${r[0]} closed at ${r[1].toLocaleString('en-US')}${r[2] == null ? '' : ', ' + pctText(r[2])}; ≈Rp ${compact(r[3])} traded, ${compact(r[4])} shares`)));
  };
  if (moversView === 'price') {
    fill('movers-up', left, r => r[2], r => pctText(r[2]), r => r[1].toLocaleString('en-US'));
    fill('movers-down', right, r => r[2], r => pctText(r[2]), r => r[1].toLocaleString('en-US'));
  } else {
    fill('movers-up', left, r => r[3], r => compact(r[3]), r => pctOr(r[2]));
    fill('movers-down', right, r => r[4], r => compact(r[4]), r => pctOr(r[2]));
  }
  more.hidden = Math.max(left.length, right.length) <= MOVERS_SHORT && moversLimit === MOVERS_SHORT;
  more.textContent = moversLimit === MOVERS_SHORT ? `Show ${MOVERS_LONG}` : `Show ${MOVERS_SHORT}`;
  document.getElementById('movers-foot').textContent = foot;
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
  if (request !== dayRequest || mode !== 'day' || moverDate !== date || moversLimit !== MOVERS_LONG) return;
  renderMovers({ ...view, title: longDate(date), note });
}

function toggleMoversLimit() {
  moversLimit = moversLimit === MOVERS_SHORT ? MOVERS_LONG : MOVERS_SHORT;
  if (moversView === 'foreign') renderForeignView();
  else if (mode === 'range') renderRangeMovers();
  else if (moversView !== 'points') renderTopView();
  else showMovers(moverDate, { force: true });
}

// Who moved it over the range: points from every stock's added-up points,
// price and activity from the range's top lists.
function renderRangeMovers() {
  if (!range) return;
  if (moversView === 'foreign') { renderForeignView(); return; }
  const title = rangeTitle();
  const real = rangeData?.change != null ? { change: rangeData.change, pct: rangeData.pct } : ihsgMove(range.from, range.to);
  if (moversView === 'points') {
    const ranked = rangeRanks();
    if (!ranked) {
      renderMoversEmpty(title, rangePending ? 'Adding up the range…' : rangeData ? 'No attribution on record for this range.' : rangeMessage);
      return;
    }
    renderMovers({ title, ...real, estimate: rangeData.estimate, counted: ranked.counted, up: ranked.up, down: ranked.down });
    return;
  }
  const n = range.sessions;
  renderTopLists({
    title, ...real,
    top: rangeData?.top,
    pending: rangePending,
    missing: rangeData ? 'No price lists on record for this range yet.' : rangeMessage,
    foot: moversView === 'price'
      ? `Across the whole listing: last close against the close before ${longDate(range.from)}. A stock that only began trading in the range, or came back from a long halt, has no move to rank.`
      : `Summed over the ${n} session${n === 1 ? '' : 's'}. Value is close × volume, an approximation — IDX's own figure prices each trade.`,
  });
}

// ── Foreign money: the headline figure and Who moved it's Foreign view ──
// Stockbit's net foreign value for every stock the Bandarmology job covers,
// added up over the session or the range on show (GET /api/foreign/{date} or
// /api/foreign/{from}/{to}; foreignSpan in backend/scrapers/bandarmology.js).
// Fetched on its own, like the movers, so the page never waits on it.
let foreignData = null;      // the answer for the span on show, null if none
let foreignPending = false;
const foreignCache = new Map();
let foreignRequest = 0;
const foreignSpanOnShow = () => (mode === 'range' && range ? [range.from, range.to] : session ? [session, session] : null);
const rpSigned = v => (v >= 0 ? '+' : '−') + compact(Math.abs(v));

async function loadForeign() {
  const span = foreignSpanOnShow();
  if (!span) return;
  const key = span[0] === span[1] ? span[0] : span.join('/');
  const request = ++foreignRequest;
  foreignPending = !foreignCache.has(key);
  foreignData = foreignCache.get(key) ?? null;
  renderForeign();
  if (!foreignPending) return;
  let payload = null;
  try {
    payload = await getJson(`/api/foreign/${key}`);
  } catch (err) {
    console.error('Foreign flow fetch error:', err);
  }
  const data = payload?.success ? payload : null;
  if (payload) foreignCache.set(key, data); // a failed request may be retried; "nothing on record" is an answer
  if (request !== foreignRequest) return;   // a newer pick won
  foreignPending = false;
  foreignData = data;
  renderForeign();
}

function renderForeign() {
  const dd = document.getElementById('hero-foreign');
  setText('hero-foreign-label', mode === 'range' ? 'Foreign net, range' : 'Foreign net');
  dd.textContent = foreignData ? rpSigned(foreignData.net).replace(/^([+−])/, '$1Rp ') : foreignPending ? '…' : '—';
  dd.style.color = foreignData ? (foreignData.net >= 0 ? UP : DOWN) : '';
  if (moversView === 'foreign') renderForeignView();
}

function renderForeignView(note = '') {
  const span = foreignSpanOnShow();
  if (!span) return;
  const inRange = mode === 'range';
  const title = inRange ? rangeTitle() : longDate(session);
  document.getElementById('movers-date').textContent = title;
  const real = ihsgMove(span[0], span[1]);
  const move = document.getElementById('movers-move');
  if (real.change != null) {
    move.textContent = `IHSG ${fmtPts(real.change)} pts (${fmtPct(real.pct)})`;
    move.className = 'movers-move ' + (real.change >= 0 ? 'up' : 'down');
  } else move.textContent = '';
  const more = document.getElementById('movers-more');
  const foot = document.getElementById('movers-foot');
  lastMovers = null;
  if (!foreignData) {
    fillMovers('movers-up', [], 1, '—');
    fillMovers('movers-down', [], 1, '—');
    more.hidden = true;
    foot.textContent = (note ? note + ' ' : '') + (foreignPending ? 'Adding up the foreign flow…'
      : `No foreign flow on record for this ${inRange ? 'range' : 'session'}. It arrives with the evening broker data, about 18:30 WIB.`);
    return;
  }
  const { buy, sell, net, stocks, sessions } = foreignData;
  const fill = (id, rows, empty) => {
    const list = rows.slice(0, moversLimit);
    if (!list.length) { fillMovers(id, [], 1, empty); return; }
    const scale = Math.max(...list.map(r => Math.abs(r[1]))) || 1;
    document.getElementById(id).replaceChildren(...list.map(([code, v, p]) => topItem(code, Math.abs(v) / scale, rpSigned(v),
      p == null ? '—' : pctText(p * 100),
      `Foreign investors net ${v >= 0 ? 'bought' : 'sold'} Rp ${compact(Math.abs(v))} of ${code}${p == null ? '' : `; its price ${pctText(p * 100)}`}`)));
  };
  fill('movers-up', buy, 'No net buying.');
  fill('movers-down', sell, 'No net selling.');
  more.hidden = Math.max(buy.length, sell.length) <= MOVERS_SHORT && moversLimit === MOVERS_SHORT;
  more.textContent = moversLimit === MOVERS_SHORT ? `Show ${MOVERS_LONG}` : `Show ${MOVERS_SHORT}`;
  const want = inRange ? range.sessions : 1;
  foot.textContent = (note ? note + ' ' : '') +
    `Across ${stocks.toLocaleString('en-US')} stocks, foreign investors were net ${net >= 0 ? 'buyers' : 'sellers'} of Rp ${compact(Math.abs(net))}` +
    (inRange ? ` over ${sessions} session${sessions === 1 ? '' : 's'}` : '') + '. ' +
    (sessions < want ? `The broker data covers ${sessions} of the range's ${want} sessions. ` : '') +
    'Beside each, its price move over the same span.';
}

// The IHSG's own move over the range, from the page's daily closes.
function ihsgMove(from, to) {
  const rows = allData.filter(d => d.date >= from && d.date <= to);
  const base = allData[allData.indexOf(rows[0]) - 1]?.ihsg, end = rows[rows.length - 1]?.ihsg;
  if (!rows.length || !(base > 0) || !(end > 0)) return {};
  return { change: end - base, pct: (end / base - 1) * 100 };
}


// Both SVG figures are drawn at their real size; redraw when that changes.
let lastWidth = window.innerWidth;
window.addEventListener('resize', debounce(() => {
  if (window.innerWidth === lastWidth) return; // a phone's toolbar showing/hiding
  lastWidth = window.innerWidth;
  if (anchor()) { renderHeatmapFig(); renderRotationFig(); }
}, 250));


// ── Start ──
fetchData();
fetchMovers();
