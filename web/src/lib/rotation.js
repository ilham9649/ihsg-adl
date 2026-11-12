// ──────────────────────────────────────────────
// Sector rotation — each sector's strength against the index, and the
// direction it is heading, week by week.
//
// Built from the movers sessions (backend/scrapers/movers.js), which carry
// each sector's index weight and the points it moved the index. A sector's
// own return on a session is pts / (previous close × weight); chained, that
// is a sector index on the same free-float weights as the estimate. The
// benchmark is the estimate itself (Σ pts / previous close) rather than the
// real IHSG, so a gap in our weights cannot read as a sector beating it.
//
// The axes approximate J. de Kempenaer's Relative Rotation Graph — whose
// exact formula is proprietary — on weekly closes:
//   RS          = sector index / benchmark
//   RS-Ratio    = 100 × RS / its 10-week average        (> 100: stronger than the index)
//   RS-Momentum = 100 × RS-Ratio / RS-Ratio a week ago  (> 100: getting stronger)
// each smoothed with a 3-week EMA: raw week-on-week momentum zigzags a small
// sector across the whole chart, which reads as rotation when it is noise.
// ──────────────────────────────────────────────

const RATIO_WEEKS = 10;
const SMOOTH_WEEKS = 3;
export const TAIL_WEEKS = 6;
const MIN_WEIGHT_BP = 20; // a sector under 0.2% of the index is too thin to read

function isoWeek(ds) {
  const dt = new Date(ds + 'T00:00:00Z');
  const day = (dt.getUTCDay() + 6) % 7;
  const th = new Date(dt); th.setUTCDate(dt.getUTCDate() - day + 3);
  const y = th.getUTCFullYear();
  return y + '-' + String(Math.floor((th - Date.UTC(y, 0, 1)) / (7 * 864e5)) + 1).padStart(2, '0');
}

/**
 * days: movers sessions, oldest first, each { date, close, change, estimate, sectors }.
 * Returns [{ sector, weightBp, points: [{ week, date, ratio, mom }] }] — the
 * last TAIL_WEEKS weeks, newest last — or [] when sectors aren't on record yet.
 */
export function computeRotation(days) {
  const withSectors = days.filter(d => d.sectors && Object.keys(d.sectors).length);
  if (withSectors.length < 2) return [];

  const levels = {};   // sector → level
  let bench = 100;
  const weeks = [];    // [{ week, date, bench, levels: { sector: level } }]
  for (const d of withSectors) {
    const base = d.close - d.change;
    if (!(base > 0)) continue;
    bench *= 1 + d.estimate / base;
    for (const [name, [bp, pts]] of Object.entries(d.sectors)) {
      if (name === 'Other' || !(bp > 0)) continue;
      levels[name] = (levels[name] ?? 100) * (1 + pts / (base * bp / 1e4));
    }
    const wk = isoWeek(d.date);
    const snap = { week: wk, date: d.date, bench, levels: { ...levels } };
    if (weeks.length && weeks[weeks.length - 1].week === wk) weeks[weeks.length - 1] = snap;
    else weeks.push(snap);
  }

  const latest = withSectors[withSectors.length - 1].sectors;
  const out = [];
  for (const name of Object.keys(levels)) {
    const weightBp = latest[name]?.[0] ?? 0;
    if (weightBp < MIN_WEIGHT_BP) continue;
    const rs = weeks.map(w => (w.levels[name] != null ? w.levels[name] / w.bench : null));
    const ratio = rs.map((v, i) => {
      if (v == null || i < RATIO_WEEKS - 1) return null;
      const win = rs.slice(i - RATIO_WEEKS + 1, i + 1);
      if (win.some(x => x == null)) return null;
      return 100 * v / (win.reduce((a, b) => a + b, 0) / win.length);
    });
    const sRatio = ema(ratio, SMOOTH_WEEKS);
    const sMom = ema(sRatio.map((v, i) => (v != null && sRatio[i - 1] != null ? 100 * v / sRatio[i - 1] : null)), SMOOTH_WEEKS);
    const points = [];
    for (let i = 1; i < weeks.length; i++) {
      if (sRatio[i] == null || sMom[i] == null) continue;
      points.push({ week: weeks[i].week, date: weeks[i].date, ratio: sRatio[i], mom: sMom[i] });
    }
    if (points.length) out.push({ sector: name, weightBp, points: points.slice(-TAIL_WEEKS) });
  }
  return out.sort((a, b) => b.weightBp - a.weightBp);
}

// EMA over a series with leading nulls; a null mid-series restarts it.
function ema(values, span) {
  const a = 2 / (span + 1);
  let prev = null;
  return values.map(v => {
    if (v == null) { prev = null; return null; }
    prev = prev == null ? v : a * v + (1 - a) * prev;
    return prev;
  });
}

export const quadrant = (ratio, mom) =>
  ratio >= 100 ? (mom >= 100 ? 'Leading' : 'Weakening') : (mom >= 100 ? 'Improving' : 'Lagging');

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs) => {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
// One distinct colour per sector, in alphabetical order of Yahoo's eleven
// sector names, so a sector keeps its colour from session to session.
const PALETTE = ['#2f6b4f', '#b0392c', '#3f5170', '#a67a26', '#7a4b8c', '#2a8fa0', '#8c5a2b', '#6b7a1f', '#c2457a', '#4a443c', '#d07a2a', '#1f5f8f'];
const SECTORS = ['Basic Materials', 'Communication Services', 'Consumer Cyclical', 'Consumer Defensive', 'Energy',
  'Financial Services', 'Healthcare', 'Industrials', 'Real Estate', 'Technology', 'Utilities'];
const colorOf = name => PALETTE[SECTORS.includes(name) ? SECTORS.indexOf(name) : PALETTE.length - 1];

/** Draw `series` (from computeRotation) into `svg`; returns the legend entries. */
export function renderRotation(svg, series, { width = 1000, height = 560, onHover = () => {} } = {}) {
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  if (!series.length) return [];
  const all = series.flatMap(s => s.points);
  // Symmetric about 100 on each axis, so the quadrants are equal and centred.
  // Scaled to the 90th percentile of distance from 100, so one outlying
  // sector can't squeeze the rest into the middle; anything past it is drawn
  // at the edge (the readout still gives its true figures).
  const p90 = vals => { const v = vals.slice().sort((a, b) => a - b); return v[Math.floor(v.length * 0.9)] || 0; };
  const heads = series.map(s => s.points[s.points.length - 1]);
  const spanX = Math.max(1, p90(all.map(p => Math.abs(p.ratio - 100))), ...heads.map(p => Math.abs(p.ratio - 100))) * 1.12;
  const spanY = Math.max(0.3, p90(all.map(p => Math.abs(p.mom - 100))), ...heads.map(p => Math.abs(p.mom - 100))) * 1.12;
  const pad = 36;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const x = v => clamp(pad + (v - (100 - spanX)) / (2 * spanX) * (width - 2 * pad), pad, width - pad);
  const y = v => clamp(height - pad - (v - (100 - spanY)) / (2 * spanY) * (height - 2 * pad), pad, height - pad);
  const cx = x(100), cy = y(100);

  const quads = [
    ['Improving', pad, pad, 'rot-q improving'], ['Leading', cx, pad, 'rot-q leading'],
    ['Lagging', pad, cy, 'rot-q lagging'], ['Weakening', cx, cy, 'rot-q weakening'],
  ];
  for (const [label, qx, qy, cls] of quads) {
    svg.appendChild(svgEl('rect', { x: qx, y: qy, width: (label === 'Improving' || label === 'Lagging') ? cx - pad : width - pad - cx, height: (label === 'Improving' || label === 'Leading') ? cy - pad : height - pad - cy, class: cls }));
    const t = svgEl('text', { x: label === 'Improving' || label === 'Lagging' ? pad + 10 : width - pad - 10, y: label === 'Improving' || label === 'Leading' ? pad + 18 : height - pad - 10, class: 'rot-qlabel', 'text-anchor': label === 'Improving' || label === 'Lagging' ? 'start' : 'end' });
    t.textContent = label;
    svg.appendChild(t);
  }
  svg.appendChild(svgEl('line', { x1: cx, x2: cx, y1: pad, y2: height - pad, class: 'rot-axis' }));
  svg.appendChild(svgEl('line', { x1: pad, x2: width - pad, y1: cy, y2: cy, class: 'rot-axis' }));
  const ax = svgEl('text', { x: width - pad, y: cy - 6, class: 'rot-axlabel', 'text-anchor': 'end' });
  ax.textContent = 'Relative strength →';
  const ay = svgEl('text', { x: cx + 6, y: pad + 12, class: 'rot-axlabel' });
  ay.textContent = '↑ Momentum';
  svg.append(ax, ay);

  const legend = [];
  const marks = [];
  const placed = []; // label boxes already drawn, to skip a colliding one
  for (const s of series) {
    const color = colorOf(s.sector);
    const g = svgEl('g', { class: 'rot-series' });
    const pts = s.points.map(p => [x(p.ratio), y(p.mom)]);
    g.appendChild(svgEl('polyline', { points: pts.map(p => p.join(',')).join(' '), stroke: color, class: 'rot-tail' }));
    pts.slice(0, -1).forEach(([px, py], i) => g.appendChild(svgEl('circle', { cx: px, cy: py, r: 2 + i * 0.4, fill: color, opacity: .5 })));
    const [hx, hy] = pts[pts.length - 1];
    g.appendChild(svgEl('circle', { cx: hx, cy: hy, r: 6, fill: color, class: 'rot-head' }));
    // Label only where it fits: the legend below names every sector.
    const lw = s.sector.length * 6.6 + 4, lx = hx + 9 > width - pad - lw ? hx - 9 - lw : hx + 9;
    const box = [lx, hy - 10, lx + lw, hy + 6];
    // On a phone the plot is too small for names: the legend and a tap name them.
    if (width >= 600 && !placed.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) {
      const label = svgEl('text', { x: lx, y: hy + 4, class: 'rot-label' });
      label.textContent = s.sector;
      g.appendChild(label);
      placed.push(box);
    }
    svg.appendChild(g);
    const last = s.points[s.points.length - 1];
    marks.push({ s, hx, hy, g });
    legend.push({ sector: s.sector, color, quadrant: quadrant(last.ratio, last.mom), ratio: last.ratio, mom: last.mom, weightBp: s.weightBp });
  }

  let active = null;
  const pick = e => {
    const box = svg.getBoundingClientRect();
    const px = (e.clientX - box.left) / box.width * width, py = (e.clientY - box.top) / box.height * height;
    let best = null, bestD = 30 * 30;
    for (const h of marks) { const d = (h.hx - px) ** 2 + (h.hy - py) ** 2; if (d < bestD) { bestD = d; best = h; } }
    if (best === active) return;
    active = best;
    for (const h of marks) h.g.classList.toggle('dim', !!active && h !== active);
    onHover(active ? legend[marks.indexOf(active)] : null);
  };
  svg.onpointermove = pick;
  svg.onpointerdown = pick;
  svg.onpointerleave = () => { active = null; marks.forEach(h => h.g.classList.remove('dim')); onHover(null); };
  return legend;
}
