// ──────────────────────────────────────────────
// The session heatmap — every index stock as a block, sized by its index
// weight, coloured by its own move, grouped by sector. Inline SVG built from
// DOM nodes (tickers come from the API, never parsed as markup).
// ──────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs) => {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

// Squarified treemap (Bruls, Huizing & van Wijk): lay items in rows along the
// shorter side, adding to a row while that keeps its blocks closer to square.
// items: [{ value, ... }] (value > 0), sorted biggest first. Returns
// [{ item, x, y, w, h }].
export function squarify(items, x, y, w, h) {
  const out = [];
  const total = items.reduce((s, it) => s + it.value, 0);
  if (!(total > 0) || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let rest = items.map(it => ({ item: it, area: it.value * scale }));
  let rx = x, ry = y, rw = w, rh = h;

  const worst = (row, side) => {
    const s = row.reduce((a, r) => a + r.area, 0);
    let max = 0;
    for (const r of row) max = Math.max(max, (side * side * r.area) / (s * s), (s * s) / (side * side * r.area));
    return max;
  };

  while (rest.length) {
    const side = Math.min(rw, rh);
    const row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) row.push(rest[i++]);
    rest = rest.slice(i);
    const sum = row.reduce((a, r) => a + r.area, 0);
    if (rw >= rh) { // row runs down the left edge
      const cw = sum / rh;
      let cy = ry;
      for (const r of row) { const ch = r.area / cw; out.push({ item: r.item, x: rx, y: cy, w: cw, h: ch }); cy += ch; }
      rx += cw; rw -= cw;
    } else {        // row runs along the top edge
      const ch = sum / rw;
      let cx = rx;
      for (const r of row) { const cw = r.area / ch; out.push({ item: r.item, x: cx, y: ry, w: cw, h: ch }); cx += cw; }
      ry += ch; rh -= ch;
    }
  }
  return out;
}

// Diverging colour: red below zero, green above, paper-grey at zero, full
// strength at ±5% (most sessions' moves sit well inside that).
const NEG = [176, 57, 44], POS = [47, 107, 79], MID = [222, 214, 199];
export function moveColor(pct) {
  const t = Math.max(-1, Math.min(1, (pct || 0) / 5));
  const [a, b] = t < 0 ? [MID, NEG] : [MID, POS];
  const k = Math.abs(t) ** 0.7; // lift small moves off the grey
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`;
}

/**
 * Draw `stocks` ([ticker, pts, pct, weightBp, sector]) into `svg`, which is
 * W×H in its own units (it scales to its box). onHover(stock | null) reports
 * the block under the pointer.
 */
export function renderHeatmap(svg, stocks, { width = 1000, height = 520, onHover = () => {} } = {}) {
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const rows = stocks.filter(s => s[3] > 0).map(s => ({ ticker: s[0], pts: s[1], pct: s[2], value: s[3], sector: s[4] || 'Other' }));
  if (!rows.length) return 0;

  const bySector = new Map();
  for (const r of rows) {
    if (!bySector.has(r.sector)) bySector.set(r.sector, []);
    bySector.get(r.sector).push(r);
  }
  const sectors = [...bySector.entries()]
    .map(([name, list]) => ({ name, list: list.sort((a, b) => b.value - a.value), value: list.reduce((s, r) => s + r.value, 0) }))
    .sort((a, b) => b.value - a.value);

  const HEAD = 15;
  const blocks = [];
  for (const sec of squarify(sectors, 0, 0, width, height)) {
    const g = svgEl('g', {});
    const showHead = sec.w > 60 && sec.h > 40;
    const top = showHead ? HEAD : 0;
    if (showHead) {
      const label = svgEl('text', { x: sec.x + 4, y: sec.y + 11, class: 'hm-sector' });
      // Cut to the block's width (~6.5px a character) so it never runs into the next.
      const fit = Math.floor((sec.w - 8) / 6.5);
      label.textContent = sec.item.name.length > fit ? sec.item.name.slice(0, Math.max(1, fit - 1)) + '…' : sec.item.name;
      g.appendChild(label);
    }
    for (const b of squarify(sec.item.list, sec.x, sec.y + top, sec.w, sec.h - top)) {
      const r = b.item;
      const rect = svgEl('rect', {
        x: b.x + .5, y: b.y + .5, width: Math.max(0, b.w - 1), height: Math.max(0, b.h - 1),
        fill: moveColor(r.pct), class: 'hm-block',
      });
      g.appendChild(rect);
      if (b.w > 34 && b.h > 18) {
        const big = b.w > 70 && b.h > 42;
        const t = svgEl('text', { x: b.x + b.w / 2, y: b.y + b.h / 2 + (b.h > 32 ? -2 : 4), class: big ? 'hm-code big' : 'hm-code' });
        t.textContent = r.ticker;
        g.appendChild(t);
        if (b.h > 32) {
          const p = svgEl('text', { x: b.x + b.w / 2, y: b.y + b.h / 2 + (big ? 16 : 11), class: 'hm-pct' });
          p.textContent = (r.pct >= 0 ? '+' : '−') + Math.abs(r.pct).toFixed(1) + '%';
          g.appendChild(p);
        }
      }
      blocks.push({ ...b, rect });
    }
    svg.appendChild(g);
  }
  // Sector outlines on top, so the grouping reads at a glance.
  for (const sec of squarify(sectors, 0, 0, width, height)) {
    svg.appendChild(svgEl('rect', { x: sec.x, y: sec.y, width: sec.w, height: sec.h, class: 'hm-sector-edge' }));
  }

  let active = null;
  const pick = e => {
    const box = svg.getBoundingClientRect();
    const px = (e.clientX - box.left) / box.width * width, py = (e.clientY - box.top) / box.height * height;
    const hit = blocks.find(b => px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h) || null;
    if (hit === active) return;
    active?.rect.classList.remove('lit');
    active = hit;
    active?.rect.classList.add('lit');
    onHover(hit ? hit.item : null);
  };
  svg.onpointermove = pick;
  svg.onpointerdown = pick;
  svg.onpointerleave = () => { active?.rect.classList.remove('lit'); active = null; onHover(null); };
  return rows.length;
}
