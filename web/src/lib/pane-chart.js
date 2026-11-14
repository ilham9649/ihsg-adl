// ──────────────────────────────────────────────
// PaneChart — one canvas, several panes stacked on one date axis.
// A BreadthChart subclass (same palette, ticks, x-axis and pointer handling),
// for a price with readings underneath: candles on top, then one pane per
// reading, each on its own y-scale. Never two scales in one pane.
//
// panes: [{ id, label, kind: 'candle' | 'line' | 'bars', field, height,
//           color, area0, fmt, tipFmt, signColor }]
//   candle  reads open/high/low/close (a row with no open is drawn as a tick)
//   line    one line in `color`; `area0` fills green above zero, red below
//   bars    one bar per session from zero, green up, red down
// ──────────────────────────────────────────────
import { BreadthChart } from './breadth-chart.js';

const GAP = 18; // between panes; room for the next pane's label

export class PaneChart extends BreadthChart {
  constructor(canvas, tooltip, opts = {}) {
    super(canvas, tooltip, { ...opts, panel: 'panes', legend: false, tipAd: false });
    this.panes = opts.panes || [];
    this.padT = 22;
  }

  /** Change which panes show; the canvas grows or shrinks to fit them. */
  setPanes(panes) {
    this.panes = panes;
    const h = this.padT + this.padB + panes.reduce((s, p) => s + p.height, 0) + GAP * Math.max(0, panes.length - 1);
    this.canvas.style.height = h + 'px';
    this._resize();
  }

  _layout() {
    const x = this.padL, w = this.w - this.padL - this.padR;
    let y = this.padT;
    return this.panes.map(pane => {
      const p = { x, y, w, h: pane.height };
      y += pane.height + GAP;
      return { pane, p };
    });
  }

  _draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const rows = this.data, n = rows.length;
    if (!n || !this.panes.length) {
      ctx.fillStyle = this.col.text;
      ctx.font = '13px JetBrains Mono, monospace';
      ctx.fillText(n ? '' : 'No data', this.padL + 8, this.h / 2);
      return;
    }
    this._panes = this._layout();
    for (const lp of this._panes) lp.sy = this._drawPane(rows, lp.pane, lp.p);
    const last = this._panes[this._panes.length - 1].p;
    this._drawXAxis(last, n);
    if (this.hover >= 0 && this.hover < n) this._drawCrosshair(rows);
  }

  // Domain of a pane over all rows; candles span low to high.
  _domain(rows, pane) {
    let lo = Infinity, hi = -Infinity;
    const inc = v => { if (v == null || !isFinite(v)) return; if (v < lo) lo = v; if (v > hi) hi = v; };
    for (const r of rows) {
      if (pane.kind === 'candle') { inc(r.low ?? r.close); inc(r.high ?? r.close); }
      else inc(r[pane.field]);
    }
    if (pane.kind === 'bars' || pane.area0) inc(0);
    if (lo === Infinity) return null;
    if (lo === hi) { lo -= 1; hi += 1; }
    return [lo, hi];
  }

  _drawPane(rows, pane, p) {
    const ctx = this.ctx, n = rows.length;
    const dom = this._domain(rows, pane);
    // Pane label, top left, sitting in the gap above the pane.
    ctx.font = '600 10px JetBrains Mono, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = this.col.text;
    ctx.fillText(pane.label.toUpperCase(), p.x, p.y - 4);
    // Hairline frame under each pane, so the stack reads as separate plots.
    ctx.strokeStyle = 'rgba(29,24,19,0.18)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(p.x, Math.round(p.y + p.h) + 0.5); ctx.lineTo(p.x + p.w, Math.round(p.y + p.h) + 0.5); ctx.stroke();
    if (!dom) return null;

    const scale = this._scale(dom[0], dom[1], p.h);
    const sy = v => p.y + scale.y(v);
    const fmt = pane.fmt || (v => this._fmt(v));

    // Grid and right-hand labels at nice ticks; fewer on short panes.
    const ticks = this._niceTicks(scale.lo, scale.hi, p.h >= 200 ? 5 : 2);
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.textBaseline = 'middle';
    for (const t of ticks) {
      const y = sy(t);
      if (y < p.y + 4 || y > p.y + p.h - 4) continue;
      ctx.strokeStyle = this.col.grid;
      ctx.beginPath(); ctx.moveTo(p.x, Math.round(y) + 0.5); ctx.lineTo(p.x + p.w, Math.round(y) + 0.5); ctx.stroke();
      ctx.fillStyle = this.col.text;
      ctx.fillText(fmt(t), p.x + p.w + 6, y);
    }
    if (scale.lo < 0 && scale.hi > 0) {
      const zy = Math.round(sy(0)) + 0.5;
      ctx.strokeStyle = 'rgba(29,24,19,0.3)'; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(p.x, zy); ctx.lineTo(p.x + p.w, zy); ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
    const slot = p.w / n;
    if (pane.kind === 'candle') {
      const cw = Math.max(1, Math.min(slot * 0.7, 12));
      for (let i = 0; i < n; i++) {
        const r = rows[i];
        if (r.close == null) continue;
        const x = Math.round(this._xAt(i, n, p)) + 0.5;
        const o = r.open ?? r.close, h = r.high ?? Math.max(o, r.close), l = r.low ?? Math.min(o, r.close);
        const up = r.close >= o;
        ctx.strokeStyle = up ? this.col.wickUp : this.col.wickDown; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, sy(h)); ctx.lineTo(x, sy(l)); ctx.stroke();
        const yO = sy(o), yC = sy(r.close);
        ctx.fillStyle = up ? this.col.up : this.col.down;
        ctx.fillRect(x - cw / 2, Math.min(yO, yC), cw, Math.max(1, Math.abs(yC - yO)));
      }
    } else if (pane.kind === 'bars') {
      const bw = Math.max(1, slot * 0.7 - (slot > 4 ? 1 : 0));
      const zy = sy(0);
      for (let i = 0; i < n; i++) {
        const v = rows[i][pane.field];
        if (v == null) continue;
        const y = sy(v);
        ctx.fillStyle = v >= 0 ? this.col.up : this.col.down;
        ctx.fillRect(this._xAt(i, n, p) - bw / 2, Math.min(y, zy), bw, Math.max(1, Math.abs(y - zy)));
      }
    } else {
      const line = new Path2D(), area = new Path2D();
      let first = null, lastX = null, started = false;
      for (let i = 0; i < n; i++) {
        const v = rows[i][pane.field];
        if (v == null) { started = false; continue; }
        const x = this._xAt(i, n, p), y = sy(v);
        if (!started) { line.moveTo(x, y); started = true; } else line.lineTo(x, y);
        if (first == null) { first = x; area.moveTo(x, sy(0)); }
        area.lineTo(x, y); lastX = x;
      }
      if (pane.area0 && first != null) {
        const zy = sy(0);
        area.lineTo(lastX, zy); area.closePath();
        ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y, p.w, zy - p.y); ctx.clip();
        ctx.fillStyle = this.col.fill; ctx.fill(area); ctx.strokeStyle = this.col.up; ctx.lineWidth = 1.8; ctx.stroke(line);
        ctx.restore();
        ctx.save(); ctx.beginPath(); ctx.rect(p.x, zy, p.w, p.y + p.h - zy); ctx.clip();
        ctx.fillStyle = this.col.fillDown; ctx.fill(area); ctx.strokeStyle = this.col.down; ctx.lineWidth = 1.8; ctx.stroke(line);
        ctx.restore();
      } else {
        ctx.strokeStyle = pane.color || this.col.line; ctx.lineWidth = 1.8; ctx.stroke(line);
      }
    }
    ctx.restore();
    return sy;
  }

  _drawCrosshair(rows) {
    const ctx = this.ctx, i = this.hover, r = rows[i], n = rows.length;
    const top = this._panes[0].p, bottom = this._panes[this._panes.length - 1].p;
    const x = this._xAt(i, n, top);
    ctx.strokeStyle = this.col.cross; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, top.y); ctx.lineTo(x, bottom.y + bottom.h); ctx.stroke();
    ctx.setLineDash([]);
    for (const { pane, sy } of this._panes) {
      if (pane.kind !== 'line' || !sy || r[pane.field] == null) continue;
      const v = r[pane.field];
      ctx.beginPath(); ctx.arc(x, sy(v), 3.4, 0, Math.PI * 2);
      ctx.fillStyle = pane.area0 ? (v >= 0 ? this.col.up : this.col.down) : (pane.color || this.col.line);
      ctx.fill();
      ctx.strokeStyle = this.col.bg; ctx.lineWidth = 1.5; ctx.stroke();
    }
    this._tooltipFor(rows, i, x);
  }

  _tooltipFor(rows, i, x) {
    const tip = this.tooltip;
    if (!tip) return;
    const r = rows[i], prev = rows[i - 1];
    const row = (label, value, color) => {
      const d = document.createElement('div'); d.className = 'bc-row';
      const s = document.createElement('span'); s.textContent = label;
      const b = document.createElement('b'); b.textContent = value;
      if (color) b.style.color = color;
      d.append(s, b);
      return d;
    };
    const date = document.createElement('div'); date.className = 'bc-date'; date.textContent = r.date;
    const out = [date];
    for (const { pane } of this._panes) {
      if (pane.kind === 'candle') {
        const p = v => v == null ? '—' : Number(v).toLocaleString('en-US');
        if (r.open != null) out.push(row('Open', p(r.open)), row('High', p(r.high)), row('Low', p(r.low)));
        out.push(row('Close', p(r.close)));
        if (prev?.close) {
          const chg = r.close / prev.close - 1;
          out.push(row('Day', (chg >= 0 ? '+' : '−') + Math.abs(chg * 100).toFixed(2) + '%', chg >= 0 ? this.col.up : this.col.down));
        }
      } else {
        const v = r[pane.field];
        const text = v == null ? '—' : (pane.tipFmt || pane.fmt || (t => this._fmt(t)))(v);
        const color = v != null && pane.signColor ? (v >= 0 ? this.col.up : this.col.down) : null;
        out.push(row(pane.tipLabel || pane.label, text, color));
      }
    }
    tip.replaceChildren(...out);
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    let left = x + 14;
    if (left + tw > this.w - 4) left = x - tw - 14;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = '10px';
  }
}
