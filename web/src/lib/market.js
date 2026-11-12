// ──────────────────────────────────────────────
// Market Map — one trading session at a time: what the IHSG did, which
// stocks moved it, the session map, the top lists and sector rotation.
// The session on show is picked with the ‹ date › navigator or a click on
// any candle. The breadth indicators live on their own page (breadth.js).
// ──────────────────────────────────────────────
import { BreadthChart } from './breadth-chart.js';
import { API_BASE, getJson, setFreshness, setFreshnessError, debounce, sparkline } from './shared.js';
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
const panels = {};
// The candles cover the movers' trailing year: every session in them can be read.
const MAP_SESSIONS = 252;

// ── Init ──
document.getElementById('session-prev').addEventListener('click', () => stepSession(-1));
document.getElementById('session-next').addEventListener('click', () => stepSession(1));
document.getElementById('session-day').addEventListener('change', e => pickSession(e.target.value));
document.getElementById('session-latest').addEventListener('click', () => setSession(allData[allData.length - 1].date));
document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => setMoversView(btn.dataset.view)));
document.getElementById('movers-mode-day').addEventListener('click', () => setMoversMode('day'));
document.getElementById('movers-mode-range').addEventListener('click', () => setMoversMode('range'));
document.getElementById('movers-more').addEventListener('click', toggleMoversLimit);
for (const id of ['movers-from', 'movers-to']) document.getElementById(id).addEventListener('change', loadRange);

// ── Fetch ──
async function fetchData() {
  try {
    const data = await getJson('/api/ad');
    if (!data.success || !data.data?.length) { setFreshness(null); return; }
    allData = data.data;
    setFreshness(allData[allData.length - 1].date);
    session = allData[allData.length - 1].date;
    const day = document.getElementById('session-day');
    day.min = allData[Math.max(0, allData.length - MAP_SESSIONS)].date;
    day.max = session;
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
  panels.ihsg.setPinned(data.findIndex(d => d.date === session));
  panels.ihsg.onPick = i => { if (data[i]) setSession(data[i].date); };
  linkBreadth(panels.ihsg);
}

// ── Headline and tiles: the session's own numbers ──
const fmtIdx = v => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function renderHero() {
  if (!allData.length || !session) return;
  const at = allData.findIndex(d => d.date === session);
  const row = allData[at], prev = allData[at - 1];
  if (!row) return;
  document.getElementById('hero-date').textContent = longDate(session);
  const fig = document.getElementById('hero-close');
  fig.textContent = row.ihsg != null ? fmtIdx(row.ihsg) : '—';
  const verdict = document.getElementById('hero-move');
  if (row.ihsg != null && prev?.ihsg) {
    const ch = row.ihsg - prev.ihsg;
    verdict.textContent = `${fmtPts(ch)} pts (${fmtPct(ch / prev.ihsg * 100)})`;
    verdict.style.color = fig.style.color = ch >= 0 ? UP : DOWN;
  } else verdict.textContent = '';
  document.getElementById('hero-range').textContent = row.ihsgLow != null ? `${fmtIdx(row.ihsgLow)} – ${fmtIdx(row.ihsgHigh)}` : '—';
  document.getElementById('hero-pctadv').textContent = row.pctAdvancing != null ? row.pctAdvancing.toFixed(1) + '%' : '—';

  const recent = allData.slice(Math.max(0, at - 29), at + 1);
  const tile = (id, text, tone, spark, ref = null) => {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = 'tile-value ' + (tone || '');
    if (spark) sparkline(document.getElementById(id + '-spark'), recent.map(spark), { ref });
  };
  tile('advances', String(row.advances), 'up', d => d.advances);
  tile('declines', String(row.declines), 'down', d => d.declines);
  tile('ratio', row.ratio.toFixed(2), row.ratio >= 1 ? 'up' : 'down', d => d.ratio, 1);

  // From the movers: who did the most, and how close the estimate came.
  const day = moversByDate.get(session);
  const mover = (id, m) => {
    document.getElementById(id).textContent = m ? m.ticker : '—';
    document.getElementById(id + '-note').textContent = m ? `${fmtPts(m.pts)} pts · ${fmtPct(m.pct)}` : 'Not on record';
  };
  mover('lifter', day?.up?.[0]);
  mover('dragger', day?.down?.[0]);
  document.getElementById('estimate').textContent = day ? fmtPts(day.estimate) : '—';
  document.getElementById('estimate-note').textContent = day ? `Our weights, against the real ${fmtPts(day.change)}` : 'Not on record';
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
    renderHero();
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
  renderHero();
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
