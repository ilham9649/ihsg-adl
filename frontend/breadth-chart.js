// ──────────────────────────────────────────────
// BreadthChart — dependency-free canvas chart for market breadth.
// panel option: 'price' (IHSG candlesticks) | 'adline' (cumulative A/D Line area)
//   Use two instances for two separate charts. No build step, no plugins.
// ──────────────────────────────────────────────
(function () {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  class BreadthChart {
    constructor(canvas, tooltip, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.tooltip = tooltip || null;
      this.panel = opts.panel || 'price'; // 'price' | 'adline'
      this.data = [];
      this.dpr = Math.max(1, window.devicePixelRatio || 1);
      this.hover = -1;

      // layout
      this.padR = 60;
      this.padL = 12;
      this.padT = 16;
      this.padB = 26;

      this.col = {
        grid: 'rgba(255,255,255,0.05)',
        axis: '#5b6b7e',
        text: '#8899aa',
        up: '#22c55e',
        down: '#ef4444',
        line: '#c9a96e',
        lineDown: '#ef4444',
        fill: 'rgba(201,169,110,0.14)',
        fillDown: 'rgba(239,68,68,0.12)',
        cross: 'rgba(255,255,255,0.25)',
        wickUp: 'rgba(34,197,94,0.9)',
        wickDown: 'rgba(239,68,68,0.9)',
      };

      this._onMove = this._onMove.bind(this);
      this._onLeave = this._onLeave.bind(this);
      this._resize = this._resize.bind(this);

      canvas.addEventListener('mousemove', this._onMove);
      canvas.addEventListener('mouseleave', this._onLeave);
      this._ro = new ResizeObserver(this._resize);
      this._ro.observe(canvas);
    }

    setData(rows) {
      this.data = (rows || []).filter(r => r != null);
      this._resize();
    }

    destroy() {
      this._ro.disconnect();
      this.canvas.removeEventListener('mousemove', this._onMove);
      this.canvas.removeEventListener('mouseleave', this._onLeave);
    }

    _resize() {
      const c = this.canvas, dpr = this.dpr;
      const w = c.clientWidth, h = c.clientHeight || 320;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      this.w = w; this.h = h;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._draw();
    }

    _plot() {
      const plotW = this.w - this.padL - this.padR;
      const plotH = this.h - this.padT - this.padB;
      return { x: this.padL, y: this.padT, w: plotW, h: plotH };
    }

    _xAt(i, n, p) { return p.x + (i + 0.5) * (p.w / n); }

    _scale(domainMin, domainMax, pxH) {
      const pad = (domainMax - domainMin) * 0.06 || 1;
      const lo = domainMin - pad, hi = domainMax + pad;
      return { lo, hi, y: (v) => pxH * (hi - v) / (hi - lo) };
    }

    _niceTicks(min, max, count) {
      const span = max - min || 1;
      const step0 = span / count;
      const mag = Math.pow(10, Math.floor(Math.log10(step0)));
      const norm = step0 / mag;
      const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
      const start = Math.ceil(min / step) * step;
      const ticks = [];
      for (let v = start; v <= max + 1e-9; v += step) ticks.push(v);
      return ticks;
    }

    _fmt(v) {
      if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k';
      return Number(v).toFixed(0);
    }

    _draw() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      const rows = this.data;
      const p = this._plot();
      if (rows.length === 0) {
        ctx.fillStyle = this.col.text;
        ctx.font = '13px IBM Plex Sans, sans-serif';
        ctx.fillText('No data', this.padL + 8, this.h / 2);
        return;
      }
      if (this.panel === 'price') this._drawPrice(rows, p);
      else this._drawADLine(rows, p);
      if (this.hover >= 0 && this.hover < rows.length) this._drawCrosshair(rows, p);
    }

    _drawGrid(p) {
      const ctx = this.ctx;
      ctx.strokeStyle = this.col.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let g = 0; g <= 4; g++) {
        const y = Math.round(p.y + (p.h * g) / 4) + 0.5;
        ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y);
      }
      ctx.stroke();
    }

    _drawXAxis(p, n) {
      const ctx = this.ctx;
      ctx.fillStyle = this.col.text;
      ctx.font = '11px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const want = Math.min(8, n);
      for (let k = 0; k < want; k++) {
        const i = Math.floor((k + 0.5) * n / want);
        ctx.fillText(this.data[i].date.slice(5), this._xAt(i, n, p), p.y + p.h + 6);
      }
    }

    _drawPrice(rows, p) {
      const ctx = this.ctx;
      const n = rows.length;
      const hiArr = rows.map(r => r.ihsgHigh ?? r.ihsg ?? null).filter(v => v != null);
      const loArr = rows.map(r => r.ihsgLow ?? r.ihsg ?? null).filter(v => v != null);
      const hasOHLC = rows.some(r => r.ihsgOpen != null && r.ihsgHigh != null);
      const scale = (hasOHLC && hiArr.length) ? this._scale(Math.min(...loArr), Math.max(...hiArr), p.h) : null;

      this._drawGrid(p);
      if (scale) {
        const cw = Math.max(1, (p.w / n) * 0.7);
        for (let i = 0; i < n; i++) {
          const r = rows[i];
          if (r.ihsgOpen == null || r.ihsgHigh == null || r.ihsgLow == null || r.ihsg == null) continue;
          const x = this._xAt(i, n, p);
          const up = r.ihsg >= r.ihsgOpen;
          const yO = p.y + scale.y(r.ihsgOpen), yC = p.y + scale.y(r.ihsg);
          ctx.strokeStyle = up ? this.col.wickUp : this.col.wickDown; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, p.y + scale.y(r.ihsgHigh)); ctx.lineTo(x, p.y + scale.y(r.ihsgLow)); ctx.stroke();
          ctx.fillStyle = up ? this.col.up : this.col.down;
          ctx.fillRect(x - cw / 2, Math.min(yO, yC), cw, Math.max(1, Math.abs(yC - yO)));
        }
      }
      // y-axis labels (right)
      if (scale) {
        ctx.fillStyle = this.col.text; ctx.font = '11px IBM Plex Mono, monospace';
        ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        for (const t of this._niceTicks(scale.lo, scale.hi, 5)) {
          const y = p.y + scale.y(t);
          if (y < p.y || y > p.y + p.h) continue;
          ctx.fillText(this._fmt(t), p.x + p.w + 6, y);
        }
      }
      this._drawXAxis(p, n);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = this.col.axis; ctx.font = '600 10px IBM Plex Sans, sans-serif';
      ctx.fillText('IHSG', p.x + 4, p.y + 2);
    }

    _drawADLine(rows, p) {
      const ctx = this.ctx;
      const n = rows.length;
      const ad = rows.map(r => r.adLine).filter(v => v != null);
      if (ad.length < 2) { this._drawGrid(p); this._drawXAxis(p, n); return; }
      const scale = this._scale(Math.min(...ad), Math.max(...ad), p.h);
      const lastPositive = rows[rows.length - 1].adLine >= 0;
      const stroke = lastPositive ? this.col.line : this.col.lineDown;
      const fill = lastPositive ? this.col.fill : this.col.fillDown;

      this._drawGrid(p);
      const pts = [];
      for (let i = 0; i < n; i++) {
        if (rows[i].adLine == null) continue;
        pts.push([this._xAt(i, n, p), p.y + scale.y(rows[i].adLine)]);
      }
      // area
      const baseY = p.y + p.h;
      ctx.beginPath(); ctx.moveTo(pts[0][0], baseY);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.lineTo(pts[pts.length - 1][0], baseY); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      // line
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.strokeStyle = stroke; ctx.lineWidth = 1.8; ctx.stroke();
      // zero line if scale crosses 0
      if (scale.lo < 0 && scale.hi > 0) {
        const zy = p.y + scale.y(0);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, zy); ctx.lineTo(p.x + p.w, zy); ctx.stroke(); ctx.setLineDash([]);
      }
      // y-axis labels
      ctx.fillStyle = this.col.text; ctx.font = '11px IBM Plex Mono, monospace';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      for (const t of this._niceTicks(scale.lo, scale.hi, 5)) {
        const y = p.y + scale.y(t);
        if (y < p.y || y > p.y + p.h) continue;
        ctx.fillText(this._fmt(t), p.x + p.w + 6, y);
      }
      this._drawXAxis(p, n);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = this.col.axis; ctx.font = '600 10px IBM Plex Sans, sans-serif';
      ctx.fillText('A/D LINE', p.x + 4, p.y + 2);
    }

    _drawCrosshair(rows, p) {
      const ctx = this.ctx;
      const i = this.hover;
      const r = rows[i];
      const x = this._xAt(i, rows.length, p);
      ctx.strokeStyle = this.col.cross; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(x, p.y + p.h, 2, 0, Math.PI * 2); ctx.fillStyle = this.col.cross; ctx.fill();
      this._updateTooltip(r, x);
    }

    _updateTooltip(r, x) {
      if (!this.tooltip) return;
      const tip = this.tooltip;
      tip.replaceChildren();
      const fmt = (v, d = 2) => v == null ? '—' : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
      tip.appendChild(el('div', 'bc-date', r.date));

      if (this.panel === 'price') {
        const priceRow = el('div', 'bc-row');
        priceRow.appendChild(el('span', null, 'IHSG'));
        priceRow.appendChild(el('b', null, fmt(r.ihsg, 0)));
        tip.appendChild(priceRow);
        if (r.ihsgOpen != null) {
          for (const pair of [['O', r.ihsgOpen], ['H', r.ihsgHigh], ['L', r.ihsgLow], ['C', r.ihsg]]) {
            const row = el('div', 'bc-row');
            row.appendChild(el('span', null, pair[0]));
            row.appendChild(el('b', null, fmt(pair[1], 0)));
            tip.appendChild(row);
          }
          const chg = r.ihsgOpen ? ((r.ihsg - r.ihsgOpen) / r.ihsgOpen * 100) : null;
          const chgRow = el('div', 'bc-row');
          chgRow.appendChild(el('span', null, 'chg'));
          const cb = el('b', null, (chg >= 0 ? '+' : '') + (chg != null ? chg.toFixed(2) : '—') + '%');
          if (chg != null) cb.style.color = chg >= 0 ? this.col.up : this.col.down;
          chgRow.appendChild(cb);
          tip.appendChild(chgRow);
        }
      } else {
        const row = el('div', 'bc-row');
        row.appendChild(el('span', null, 'A/D Line'));
        const b = el('b', null, fmt(r.adLine, 0));
        b.style.color = this.col.line;
        row.appendChild(b);
        tip.appendChild(row);
        const sp = el('div', 'bc-row');
        sp.appendChild(el('span', null, 'day spread'));
        const sb = el('b', null, (r.spread >= 0 ? '+' : '') + r.spread);
        sb.style.color = r.spread >= 0 ? this.col.up : this.col.down;
        sp.appendChild(sb);
        tip.appendChild(sp);
      }

      tip.style.display = 'block';
      const tw = tip.offsetWidth;
      let left = x + 14;
      if (left + tw > this.w - 4) left = x - tw - 14;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = '10px';
    }

    _onMove(e) {
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const p = this._plot();
      const n = this.data.length;
      if (n === 0) return;
      const i = Math.round((px - p.x) / (p.w / n) - 0.5);
      this.hover = Math.max(0, Math.min(n - 1, i));
      this._draw();
    }

    _onLeave() {
      this.hover = -1;
      if (this.tooltip) this.tooltip.style.display = 'none';
      this._draw();
    }
  }

  window.BreadthChart = BreadthChart;
})();
