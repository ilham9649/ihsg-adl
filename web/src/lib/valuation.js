// ══════════════════════════════════════════════════════════════════
// Valuation — intrinsic value, cheapest to dearest.
// The backend does the valuing; this page places, filters and renders it.
// The spread figure is carried over from frontend/valuation.js unchanged
// (bar pointer events); the tables use the shared dataTable.
// ══════════════════════════════════════════════════════════════════
import { getJson, setFreshness, setFreshnessError, debounce } from './shared.js';
import { dataTable } from './table.js';

let allRows = [];
let ddmRows = [];
let marks = [];   // one per plotted company: { row, x, line }
let model = 'all';

// ── Formatting ──
const pct = (v, dp = 1) => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp) + '%';
const rupiah = v => v == null ? '—' : Math.round(v).toLocaleString('en-US');
const tone = v => v == null ? null : (v >= 0 ? 'td-positive' : 'td-negative');
// "PT Semen Indonesia (Persero) Tbk" → "Semen Indonesia (Persero)": the
// prefix and suffix are on every name and only push the figures off screen.
const shortName = n => (n || '—').replace(/^PT\.?\s+/i, '').replace(/,?\s+Tbk\.?$/i, '');

// ══════════════  THE SPREAD FIGURE  ══════════════
//
// Each company is one hairline, placed by log2(value / price) — the number of
// doublings between what it costs and what it is worth. A log scale because the
// raw discount runs from −1240% to +685%; on a linear axis the whole market
// collapses into a smear at one end.
//
// Left is cheap, matching the ranking's own order. Ends are labelled in words,
// so the axis never asks anyone to read a descending number line.

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_W = 1000, VIEW_H = 150;
const PLOT_TOP = 16, PLOT_BOTTOM = 112;   // where the hairlines live
const AXIS_Y = 126;                        // the baseline rule
const PLOT_RIGHT = 892;                    // the log axis ends here
const VOID_LEFT = 928;                     // the no-value block starts here
const RICH = 3, POOR = -6;                 // log2 domain, cheap → dear

// Below this the estimate is under a sixtieth of the price. Those positions are
// an artefact of rounding a near-zero value, not a reading, so they join the
// block rather than stretching the axis across an empty gap.
const VOID_FLOOR = POOR;

const el = (name, attrs) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const doublings = r => (r.fairValue > 0 && r.price > 0) ? Math.log2(r.fairValue / r.price) : -Infinity;
const isVoid = r => doublings(r) < VOID_FLOOR;
const plotX = d => PLOT_RIGHT * (RICH - d) / (RICH - POOR);

function renderSpread(rows) {
  const svg = document.getElementById('spread-strip');
  svg.replaceChildren();
  marks = [];

  const field = el('g', { class: 'field' });

  const priced = rows.filter(r => !isVoid(r)).sort((a, b) => doublings(b) - doublings(a));
  const voided = rows.filter(isVoid);
  // Median of the whole ranking, not of the plotted subset: the block companies
  // are still companies, and they all sit at the dear end.
  const median = rows.length ? rows[Math.floor(rows.length / 2)] : null;

  // The fair-value line: the whole page hangs off this one position.
  const fairX = plotX(0);
  field.appendChild(el('line', {
    x1: fairX, x2: fairX, y1: PLOT_TOP - 6, y2: AXIS_Y,
    stroke: 'var(--ink)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke',
  }));

  // One hairline per company. Low opacity so crowding darkens the field on its
  // own — the density is the data, not a chosen shade.
  const rankOf = new Map(rows.map((r, i) => [r, i + 1]));

  for (const row of priced) {
    const x = plotX(doublings(row));
    const line = el('line', {
      x1: x, x2: x, y1: PLOT_TOP, y2: PLOT_BOTTOM,
      stroke: row.upside >= 0 ? 'var(--up)' : 'var(--down)',
      'stroke-width': 1.6, 'stroke-opacity': .42,
      'vector-effect': 'non-scaling-stroke',
    });
    field.appendChild(line);
    marks.push({ row, x, line, rank: rankOf.get(row) });
  }

  // The block. These are packed into a fixed width, so they overlap into a
  // solid bar — which is the honest picture of what they are.
  const voidWidth = VIEW_W - VOID_LEFT;
  voided.forEach((row, i) => {
    const x = VOID_LEFT + (voided.length < 2 ? voidWidth / 2 : (i / (voided.length - 1)) * voidWidth);
    const line = el('line', {
      x1: x, x2: x, y1: PLOT_TOP, y2: PLOT_BOTTOM,
      stroke: 'var(--oxblood)', 'stroke-width': 2, 'stroke-opacity': .5,
      'vector-effect': 'non-scaling-stroke',
    });
    field.appendChild(line);
    marks.push({ row, x, line, rank: rankOf.get(row) });
  });

  // Broken-axis mark between the scale and the block, as a printed table would.
  for (const dx of [0, 10]) {
    field.appendChild(el('line', {
      x1: PLOT_RIGHT + 14 + dx, x2: PLOT_RIGHT + 22 + dx, y1: AXIS_Y + 5, y2: AXIS_Y - 5,
      stroke: 'var(--ink-faint)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke',
    }));
  }

  // Baseline, drawn in two runs so the break reads as a break.
  for (const [x1, x2] of [[0, PLOT_RIGHT + 8], [VOID_LEFT - 6, VIEW_W]]) {
    field.appendChild(el('line', {
      x1, x2, y1: AXIS_Y, y2: AXIS_Y,
      stroke: 'var(--ink)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke',
    }));
  }

  // Median marker.
  if (median) {
    const mx = isVoid(median) ? (VOID_LEFT + VIEW_W) / 2 : plotX(doublings(median));
    field.appendChild(el('path', {
      d: `M ${mx} ${AXIS_Y - 7} L ${mx - 5} ${AXIS_Y + 2} L ${mx + 5} ${AXIS_Y + 2} Z`,
      fill: 'var(--gold)',
    }));
  }

  svg.appendChild(field);
  renderAxis(median, voided.length);
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);

  document.getElementById('spread-alt').textContent =
    `Distribution of ${rows.length} companies by estimated worth against price. ` +
    `${rows.filter(r => r.upside > 0).length} sit below fair value; ` +
    `${voided.length} have no meaningful value. The full ranking follows in the table below.`;

  return { priced, voided, median };
}

function renderAxis(median, voidCount) {
  const axis = document.getElementById('spread-axis');
  const track = [];

  const mark = (xView, cls, top, sub) => {
    const node = document.createElement('span');
    const pos = xView / VIEW_W * 100;
    // Marks near either end anchor to their edge instead of their centre, or a
    // long label hangs off the page.
    const edge = pos < 15 ? ' at-start' : pos > 85 ? ' at-end' : '';
    node.className = 'axis-mark' + (cls ? ' ' + cls : '') + edge;
    node.style.left = pos + '%';
    node.append(top);
    if (sub) {
      const em = document.createElement('em');
      em.textContent = sub;
      node.append(em);
    }
    track.push(node);
  };

  mark(plotX(2), '', '4×', 'worth 4× the price');
  mark(plotX(0), 'anchor', 'FAIR VALUE', 'price meets worth');
  mark(plotX(-2), '', '¼', 'priced at 4× its worth');
  mark((VOID_LEFT + VIEW_W) / 2, 'void', String(voidCount), 'no meaningful value');

  // The median sits close enough to fair value to overprint it, so it takes a
  // tier of its own below the scale.
  if (median) {
    mark(isVoid(median) ? (VOID_LEFT + VIEW_W) / 2 : plotX(doublings(median)), 'median', 'MEDIAN', null);
  }

  axis.replaceChildren(...track);
}

// ── Readout ──
const readoutLabel = document.querySelector('.readout-label');
const readoutBody = document.querySelector('.readout-body');

function showReadout(label, ...parts) {
  readoutLabel.textContent = label;
  readoutBody.replaceChildren(...parts);
}

// Built as nodes, never as markup: ticker and name are whatever Yahoo returned,
// and the table takes the same care for the same reason.
const strong = (text, cls) => {
  const b = document.createElement('b');
  if (cls) b.className = cls;
  b.textContent = text;
  return b;
};

function describe(row) {
  const out = [strong(row.ticker), ' — ', row.name || 'unnamed'];

  // The reason has to match the model that produced it. A bank does not run out
  // of value because of debt; it runs out because it earns too little on book.
  if (row.fairValue <= 0) {
    out.push(row.model === 'residual-income'
      ? '. It earns less on its book than a shareholder should require, so the model finds '
      : '. Its debts outweigh the cash it can generate, so the model finds ');
    out.push(strong('no value', 'dear'), ' in the shares.');
    return out;
  }

  if (row.upside >= 0) {
    out.push(', worth ', strong(rupiah(row.fairValue), 'cheap'), ` against a price of ${rupiah(row.price)}. `);
  } else {
    out.push(`, priced at ${rupiah(row.price)} against a worth of `, strong(rupiah(row.fairValue), 'dear'), '. ');
  }

  const span = document.createElement('span');
  span.className = row.upside >= 0 ? 'cheap' : 'dear';
  span.textContent = pct(row.upside, 0);
  out.push(span);
  return out;
}

let medianRow = null;
// The resting state shows the middle of the board so the panel is not blank.
// The label carries the rank because without it the large display type reads as
// a recommendation rather than a position in the list.
function restoreReadout() {
  if (!medianRow) return;
  showReadout(`Median · rank ${allRows.indexOf(medianRow) + 1} of ${allRows.length}`, ...describe(medianRow));
}

function bindHover() {
  const svg = document.getElementById('spread-strip');

  const nearest = clientX => {
    const box = svg.getBoundingClientRect();
    const x = (clientX - box.left) / box.width * VIEW_W;
    let best = null, bestDist = Infinity;
    for (const m of marks) {
      const d = Math.abs(m.x - x);
      if (d < bestDist) { bestDist = d; best = m; }
    }
    return bestDist < 14 ? best : null;
  };

  let active = null;
  const clear = () => {
    if (active) active.line.classList.remove('lit');
    if (active) active.line.setAttribute('stroke-opacity', active.line.dataset.rest || '.42');
    active = null;
  };

  // Pointer events, so a tap on a phone reads a company the way a hover does.
  svg.addEventListener('pointermove', e => {
    const hit = nearest(e.clientX);
    if (hit === active) return;
    clear();
    if (!hit) { restoreReadout(); return; }
    active = hit;
    hit.line.dataset.rest = hit.line.getAttribute('stroke-opacity');
    hit.line.setAttribute('stroke-opacity', '1');
    showReadout(`Rank ${hit.rank} of ${allRows.length}`, ...describe(hit.row));
  });

  svg.addEventListener('pointerdown', e => svg.dispatchEvent(new PointerEvent('pointermove', e)));
  svg.addEventListener('pointerleave', () => { clear(); restoreReadout(); });
}

// ══════════════  THE TABLES  ══════════════
const TABLE_COLS = [
  { key: 'rank', head: '#', desc: 'Rank by discount to fair value', get: d => d.rank },
  { key: 'ticker', head: 'Code', desc: 'IDX ticker', get: d => d.ticker, num: false },
  { key: 'name', head: 'Company', desc: 'Registered name', get: d => shortName(d.name), title: d => d.name || '', num: false, wide: true },
  { key: 'sector', head: 'Sector', desc: 'Business sector', get: d => d.sector || '—', num: false },
  { key: 'price', head: 'Price', desc: 'Latest close, rupiah', get: d => rupiah(d.price) },
  { key: 'fairValue', head: 'Value', desc: 'Estimated intrinsic value per share, rupiah', get: d => rupiah(d.fairValue) },
  // A negative fair value means the equity is worth nothing; printing the
  // ratio as "−1240%" would read as a precise measurement of no scale.
  { key: 'upside', head: 'Discount', desc: 'How far the price sits below the estimate; negative means the price is above it', get: d => d.fairValue < 0 ? 'no value' : pct(d.upside), cls: d => tone(d.upside) },
  { key: 'growth', head: 'Growth', desc: 'Assumed annual growth — revenue rate for cash flow, retained earnings for financials', get: d => pct(d.growth) },
  { key: 'roe', head: 'ROE', desc: 'Return on equity; financials only', get: d => d.roe == null ? '—' : pct(d.roe) },
  { key: 'model', head: 'Model', desc: 'Which valuation was used', get: d => d.model === 'dcf' ? 'DCF' : 'Excess return', num: false },
  { key: 'asOf', head: 'Accounts to', desc: 'The twelve months the figures run to — the last four quarters where filed cleanly, the last full financial year otherwise', get: d => d.asOf || '—' },
];

// The gap is how much more the company keeps than it pays out.
const ddmGap = d => d.ddmFairValue / d.fairValue - 1;
const DDM_COLS = [
  { key: 'ticker', head: 'Code', desc: 'IDX ticker', get: d => d.ticker, num: false },
  { key: 'name', head: 'Company', desc: 'Registered name', get: d => shortName(d.name), title: d => d.name || '', num: false, wide: true },
  { key: 'price', head: 'Price', desc: 'Latest close, rupiah', get: d => rupiah(d.price) },
  { key: 'fairValue', head: 'Value', desc: "The company's primary fair value (DCF or excess return), rupiah", get: d => rupiah(d.fairValue) },
  { key: 'ddmFairValue', head: 'DDM', desc: 'Value implied by dividends actually paid, rupiah', get: d => rupiah(d.ddmFairValue) },
  { key: 'gap', head: 'Gap', desc: 'How far the DDM sits below the primary value', get: d => pct(ddmGap(d)), sortValue: ddmGap },
];

const ranking = dataTable({
  table: document.getElementById('data-table'), cols: TABLE_COLS, sort: { key: 'rank', dir: 1 },
  count: document.getElementById('row-count'), more: document.getElementById('row-more'), noun: ['company', 'companies'],
});
const ddm = dataTable({
  table: document.getElementById('ddm-table'), cols: DDM_COLS, sort: { key: 'gap', dir: 1 },
  count: document.getElementById('ddm-count'), more: document.getElementById('ddm-more'), noun: ['company', 'companies'],
});

// ── Filtering ──
// The figure always holds the whole market — it should not jump while someone
// types — so filtering dims the non-matching marks instead.
function applyFilters() {
  const query = document.getElementById('search-input').value.trim().toLowerCase();
  const filtering = model !== 'all' || query !== '';
  const matches = r => {
    if (model !== 'all' && r.model !== model) return false;
    if (!query) return true;
    return r.ticker.toLowerCase().includes(query) || (r.name || '').toLowerCase().includes(query);
  };
  ranking.render(allRows.filter(matches), { reset: true });
  ddm.render(ddmRows.filter(matches), { reset: true });
  for (const m of marks) {
    const on = !filtering || matches(m.row);
    m.line.setAttribute('stroke-opacity', on ? (filtering ? '.85' : '.42') : '.06');
  }
}

// ── Summary ──
function renderSummary(rows, { voided, median }) {
  medianRow = median;
  restoreReadout();
  const under = rows.filter(r => r.upside > 0).length;
  const over = rows.filter(r => r.upside <= 0 && !isVoid(r)).length;
  document.getElementById('valued-count').textContent = rows.length;
  document.getElementById('n-cheap').textContent = under;
  document.getElementById('n-dear').textContent = over;
  document.getElementById('n-void').textContent = voided.length;
  document.getElementById('n-dcf').textContent = rows.filter(r => r.model === 'dcf').length;
  document.getElementById('n-ri').textContent = rows.filter(r => r.model !== 'dcf').length;
  const gap = document.getElementById('median-gap');
  gap.textContent = median ? (median.fairValue < 0 ? 'none' : pct(median.upside, 0)) : '—';
  gap.className = 'tile-value ' + (median && median.upside >= 0 ? 'up' : 'down');
  document.getElementById('spread-finding').replaceChildren(
    'Just ', strong(String(under), 'cheap'), ' of ', strong(String(rows.length)),
    ' companies trade below what their own accounts say they are worth. ',
    strong(String(voided.length), 'dear'), ' are worth nothing at all.',
  );
}

function showEmpty(message) {
  document.getElementById('spread-finding').textContent = message;
  showReadout('No record', message);
}

// ── Fetch ──
async function fetchValuations() {
  try {
    const payload = await getJson('/api/valuation');
    if (!payload.success || !payload.data?.length) { setFreshness(null); showEmpty('No valuations on record yet.'); return; }
    // Re-sort so the page never depends on the order a stored payload arrives in.
    allRows = payload.data.slice().sort((a, b) => b.upside - a.upside);
    allRows.forEach((r, i) => { r.rank = i + 1; });
    // A negative primary value has nothing to compare the DDM against.
    ddmRows = allRows.filter(r => r.ddmFairValue != null && r.fairValue > 0);
    document.getElementById('attempted-count').textContent = payload.attempted ?? '—';
    // Valuations move when companies file, but the job runs nightly: a stamp
    // over a few days old means it has stopped.
    setFreshness(payload.updatedAt ? payload.updatedAt.slice(0, 10) : null, { label: 'Valued' });
    const spread = renderSpread(allRows);
    renderSummary(allRows, spread);
    bindHover();
    applyFilters();
  } catch (err) {
    console.error('Failed to load valuations:', err);
    setFreshnessError(err.message);
    showEmpty('Could not load the valuation record.');
  }
}

// ── Controls ──
document.querySelectorAll('#model button').forEach(btn => btn.addEventListener('click', () => {
  model = btn.dataset.model;
  document.querySelectorAll('#model button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
  applyFilters();
}));
document.getElementById('search-input').addEventListener('input', debounce(applyFilters, 150));
for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('[role=tab]')) {
      const on = t === tab;
      t.setAttribute('aria-pressed', String(on));
      t.setAttribute('aria-selected', String(on));
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
  });
}

fetchValuations();
