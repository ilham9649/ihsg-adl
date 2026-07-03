// ──────────────────────────────────────────────
// BreadthChart — dependency-free canvas chart for market breadth.
// panel option: 'price' (IHSG candlesticks) | 'series' (an oscillating breadth
//   line, e.g. % Advancing). For 'series' pass { field, label, ref, unit }.
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
      this.panel = opts.panel || 'price'; // 'price' | 'series'
      this.field = opts.field || 'pctAdvancing'; // data key for the 'series' panel
      this.rawField = opts.rawField || null; // optional faint underlay (unsmoothed)
      this.label = opts.label || '% ADVANCING';
      this.ref = (opts.ref != null) ? opts.ref : null; // neutral/reference line (e.g. 50)
      this.unit = opts.unit || '';
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
      else this._drawSeries(rows, p);
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
      // Over a multi-year window, MM-DD alone is ambiguous — show YYYY-MM instead.
      const multiYear = n > 1 && this.data[0].date.slice(0, 4) !== this.data[n - 1].date.slice(0, 4);
      for (let k = 0; k < want; k++) {
        const i = Math.floor((k + 0.5) * n / want);
        const ds = this.data[i].date;
        ctx.fillText(multiYear ? ds.slice(0, 7) : ds.slice(5), this._xAt(i, n, p), p.y + p.h + 6);
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

    _drawSeries(rows, p) {
      const ctx = this.ctx;
      const n = rows.length;
      const field = this.field, ref = this.ref;
      const vals = rows.map(r => r[field]).filter(v => v != null);
      if (vals.length < 2) { this._drawGrid(p); this._drawXAxis(p, n); return; }
      // Keep the reference line (e.g. 50%) inside the visible range.
      let dMin = Math.min(...vals), dMax = Math.max(...vals);
      if (ref != null) { dMin = Math.min(dMin, ref); dMax = Math.max(dMax, ref); }
      const scale = this._scale(dMin, dMax, p.h);
      const lastVal = rows[rows.length - 1][field];
      const above = ref != null ? lastVal >= ref : lastVal >= 0;
      const stroke = above ? this.col.up : this.col.down;
      const fill = above ? 'rgba(34,197,94,0.12)' : this.col.fillDown;

      this._drawGrid(p);
      const pts = [];
      for (let i = 0; i < n; i++) {
        if (rows[i][field] == null) continue;
        pts.push([this._xAt(i, n, p), p.y + scale.y(rows[i][field])]);
      }
      // area (anchored to the reference line when we have one, else the axis floor)
      const baseY = p.y + (ref != null ? scale.y(ref) : p.h);
      ctx.beginPath(); ctx.moveTo(pts[0][0], baseY);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.lineTo(pts[pts.length - 1][0], baseY); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      // faint unsmoothed underlay (clipped to plot so it can't distort the scale).
      // Skip it once points get dense (e.g. multi-year "All"), where it degrades
      // into noisy vertical hatching and the smoothed trend is what matters.
      if (this.rawField && n <= 250) {
        ctx.save();
        ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const rv = rows[i][this.rawField];
          if (rv == null) { started = false; continue; }
          const rx = this._xAt(i, n, p), ry = p.y + scale.y(rv);
          if (!started) { ctx.moveTo(rx, ry); started = true; } else ctx.lineTo(rx, ry);
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      }
      // line
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.strokeStyle = stroke; ctx.lineWidth = 1.8; ctx.stroke();
      // reference / neutral line
      const refVal = ref != null ? ref : ((scale.lo < 0 && scale.hi > 0) ? 0 : null);
      if (refVal != null) {
        const zy = p.y + scale.y(refVal);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, zy); ctx.lineTo(p.x + p.w, zy); ctx.stroke(); ctx.setLineDash([]);
      }
      // y-axis labels
      ctx.fillStyle = this.col.text; ctx.font = '11px IBM Plex Mono, monospace';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      for (const t of this._niceTicks(scale.lo, scale.hi, 5)) {
        const y = p.y + scale.y(t);
        if (y < p.y || y > p.y + p.h) continue;
        ctx.fillText(this._fmt(t) + this.unit, p.x + p.w + 6, y);
      }
      this._drawXAxis(p, n);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = this.col.axis; ctx.font = '600 10px IBM Plex Sans, sans-serif';
      ctx.fillText(this.label, p.x + 4, p.y + 2);
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
        const val = r[this.field];
        const above = this.ref != null ? (val >= this.ref) : (val >= 0);
        const row = el('div', 'bc-row');
        row.appendChild(el('span', null, this.label));
        const b = el('b', null, fmt(val, this.unit === '%' ? 1 : 0) + this.unit);
        b.style.color = above ? this.col.up : this.col.down;
        row.appendChild(b);
        tip.appendChild(row);
        if (this.rawField && r[this.rawField] != null) {
          const rw = el('div', 'bc-row');
          rw.appendChild(el('span', null, 'that day'));
          rw.appendChild(el('b', null, fmt(r[this.rawField], 1) + this.unit));
          tip.appendChild(rw);
        }
        const ad = el('div', 'bc-row');
        ad.appendChild(el('span', null, 'adv / dec'));
        const ab = el('b', null, r.advances + ' / ' + r.declines);
        ad.appendChild(ab);
        tip.appendChild(ad);
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
