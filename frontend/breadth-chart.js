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
      this.label = opts.label || '% ADVANCING';       // on-canvas panel label
      this.tipLabel = opts.tipLabel || this.label;     // short label used in the tooltip
      this.legendLabel = opts.legendLabel || this.tipLabel; // legend swatch label
      this.ref = (opts.ref != null) ? opts.ref : null; // neutral/reference line (e.g. 50)
      this.unit = opts.unit || '';
      // extra moving-average lines: [{ field, color, width, label, legend }]
      this.overlays = opts.overlays || [];
      this.hidden = new Set(); // line keys (field names, or 'daily') toggled off
      this.data = [];
      this.dpr = Math.max(1, window.devicePixelRatio || 1);
      this.hover = -1;
      this.onHover = null; // (i) => void  — set by the hover-sync bus
      this.onLeave = null; // () => void

      // layout
      this.padR = 60;
      this.padL = 12;
      this.padT = 16;
      this.padB = 26;

      this.col = {
        grid: 'rgba(29,24,19,0.07)',
        axis: '#948872',
        text: '#5b5147',
        up: '#2f6b4f',
        down: '#b0392c',
        line: '#1d1813',
        lineDown: '#b0392c',
        fill: 'rgba(47,107,79,0.12)',
        fillDown: 'rgba(176,57,44,0.12)',
        cross: 'rgba(29,24,19,0.35)',
        wickUp: 'rgba(47,107,79,0.9)',
        wickDown: 'rgba(176,57,44,0.9)',
        bg: '#f2ebdd',
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
        ctx.font = '13px JetBrains Mono, monospace';
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
      ctx.font = '11px JetBrains Mono, monospace';
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
        ctx.fillStyle = this.col.text; ctx.font = '11px JetBrains Mono, monospace';
        ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        for (const t of this._niceTicks(scale.lo, scale.hi, 5)) {
          const y = p.y + scale.y(t);
          if (y < p.y || y > p.y + p.h) continue;
          ctx.fillText(this._fmt(t), p.x + p.w + 6, y);
        }
      }
      this._drawXAxis(p, n);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = this.col.axis; ctx.font = '600 10px JetBrains Mono, monospace';
      ctx.fillText('IHSG', p.x + 4, p.y + 2);
    }

    _drawSeries(rows, p) {
      const ctx = this.ctx;
      const n = rows.length;
      const field = this.field, ref = this.ref, hidden = this.hidden;
      const mainVis = !hidden.has(field);
      const dailyVis = !!this.rawField && !hidden.has('daily');
      const visOverlays = this.overlays.filter(o => !hidden.has(o.field));

      // Domain from the VISIBLE lines only, so toggling a line off zooms in.
      let dMin = Infinity, dMax = -Infinity;
      const inc = (v) => { if (v == null) return; if (v < dMin) dMin = v; if (v > dMax) dMax = v; };
      if (mainVis) for (let i = 0; i < n; i++) inc(rows[i][field]);
      for (const ov of visOverlays) for (let i = 0; i < n; i++) inc(rows[i][ov.field]);
      if (dailyVis) {
        // Robust 3rd–97th percentiles so one extreme session doesn't flatten it.
        const raws = rows.map(r => r[this.rawField]).filter(v => v != null).sort((a, b) => a - b);
        if (raws.length) {
          const q = (t) => raws[Math.min(raws.length - 1, Math.max(0, Math.round(t * (raws.length - 1))))];
          inc(q(0.03)); inc(q(0.97));
        }
      }
      if (ref != null) inc(ref);

      this._drawGrid(p);
      if (dMin === Infinity) { this._drawXAxis(p, n); return; } // everything toggled off
      if (dMin === dMax) { dMin -= 1; dMax += 1; }

      const scale = this._scale(dMin, dMax, p.h);
      this._sy = (v) => p.y + scale.y(v); // value→pixel, reused by the crosshair markers
      const lastVal = rows[rows.length - 1][field];
      const above = ref != null ? lastVal >= ref : lastVal >= 0;
      const stroke = above ? this.col.up : this.col.down;
      const fill = above ? this.col.fill : this.col.fillDown;

      // main line + area (anchored to the reference line, else the axis floor)
      if (mainVis) {
        const pts = [];
        for (let i = 0; i < n; i++) {
          if (rows[i][field] == null) continue;
          pts.push([this._xAt(i, n, p), p.y + scale.y(rows[i][field])]);
        }
        if (pts.length) {
          const baseY = p.y + (ref != null ? scale.y(ref) : p.h);
          ctx.beginPath(); ctx.moveTo(pts[0][0], baseY);
          for (const [x, y] of pts) ctx.lineTo(x, y);
          ctx.lineTo(pts[pts.length - 1][0], baseY); ctx.closePath();
          ctx.fillStyle = fill; ctx.fill();
          ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
          for (const [x, y] of pts) ctx.lineTo(x, y);
          ctx.strokeStyle = stroke; ctx.lineWidth = 1.8; ctx.stroke();
        }
      }
      // Faint unsmoothed "daily" values: a dot per session (a volatility cloud on
      // long ranges) plus a connecting thread on shorter ones. Clipped to plot.
      if (dailyVis) {
        ctx.save();
        ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
        if (n <= 90) {
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < n; i++) {
            const rv = rows[i][this.rawField];
            if (rv == null) { started = false; continue; }
            const rx = this._xAt(i, n, p), ry = p.y + scale.y(rv);
            if (!started) { ctx.moveTo(rx, ry); started = true; } else ctx.lineTo(rx, ry);
          }
          ctx.strokeStyle = 'rgba(29,24,19,0.16)'; ctx.lineWidth = 1; ctx.stroke();
        }
        const rad = n > 400 ? 0.9 : 1.5;
        ctx.fillStyle = 'rgba(29,24,19,0.20)';
        for (let i = 0; i < n; i++) {
          const rv = rows[i][this.rawField];
          if (rv == null) continue;
          ctx.beginPath(); ctx.arc(this._xAt(i, n, p), p.y + scale.y(rv), rad, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
      // overlay moving-average lines (e.g. 100-day, 200-day)
      for (const ov of visOverlays) {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const v = rows[i][ov.field];
          if (v == null) { started = false; continue; }
          const ox = this._xAt(i, n, p), oy = p.y + scale.y(v);
          if (!started) { ctx.moveTo(ox, oy); started = true; } else ctx.lineTo(ox, oy);
        }
        ctx.strokeStyle = ov.color; ctx.lineWidth = ov.width || 1.4; ctx.stroke();
      }
      // reference / neutral line
      const refVal = ref != null ? ref : ((scale.lo < 0 && scale.hi > 0) ? 0 : null);
      if (refVal != null) {
        const zy = p.y + scale.y(refVal);
        ctx.strokeStyle = 'rgba(29,24,19,0.22)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, zy); ctx.lineTo(p.x + p.w, zy); ctx.stroke(); ctx.setLineDash([]);
      }
      // y-axis labels
      ctx.fillStyle = this.col.text; ctx.font = '11px JetBrains Mono, monospace';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      for (const t of this._niceTicks(scale.lo, scale.hi, 5)) {
        const y = p.y + scale.y(t);
        if (y < p.y || y > p.y + p.h) continue;
        ctx.fillText(this._fmt(t) + this.unit, p.x + p.w + 6, y);
      }
      this._drawXAxis(p, n);
      this._drawSeriesLegend(p, stroke, mainVis, visOverlays);
    }

    // Compact legend (colored swatch + short label) for the visible lines only.
    _drawSeriesLegend(p, mainColor, mainVis, visOverlays) {
      const ctx = this.ctx;
      const items = [];
      if (mainVis) items.push({ color: mainColor, label: this.legendLabel });
      for (const o of visOverlays) items.push({ color: o.color, label: o.legend || o.label });
      if (!items.length) return;
      ctx.font = '600 10px JetBrains Mono, monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      let lx = p.x + 4; const ly = p.y + 8;
      for (const it of items) {
        ctx.strokeStyle = it.color; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 13, ly); ctx.stroke();
        lx += 17;
        ctx.fillStyle = this.col.text;
        ctx.fillText(it.label, lx, ly);
        lx += ctx.measureText(it.label).width + 12;
      }
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
      // Series panels: mark the average (solid dot) and the daily value (hollow
      // ring) at the hovered date, so both tooltip figures are locatable.
      if (this.panel !== 'price' && this._sy) {
        const sv = r[this.field];
        if (sv != null && !this.hidden.has(this.field)) {
          const above = this.ref != null ? (rows[rows.length - 1][this.field] >= this.ref) : (sv >= 0);
          ctx.beginPath(); ctx.arc(x, this._sy(sv), 3.4, 0, Math.PI * 2);
          ctx.fillStyle = above ? this.col.up : this.col.down; ctx.fill();
        }
        for (const ov of this.overlays) {
          if (r[ov.field] == null || this.hidden.has(ov.field)) continue;
          ctx.beginPath(); ctx.arc(x, this._sy(r[ov.field]), 2.6, 0, Math.PI * 2);
          ctx.fillStyle = ov.color; ctx.fill();
        }
        if (this.rawField && r[this.rawField] != null && !this.hidden.has('daily')) {
          ctx.beginPath(); ctx.arc(x, this._sy(r[this.rawField]), 3, 0, Math.PI * 2);
          ctx.fillStyle = this.col.bg; ctx.fill();
          ctx.strokeStyle = 'rgba(29,24,19,0.6)'; ctx.lineWidth = 1.3; ctx.stroke();
        }
      }
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
        if (val != null && !this.hidden.has(this.field)) {
          const row = el('div', 'bc-row');
          row.appendChild(el('span', null, this.tipLabel));
          const b = el('b', null, fmt(val, this.unit === '%' ? 1 : 0) + this.unit);
          b.style.color = above ? this.col.up : this.col.down;
          row.appendChild(b);
          tip.appendChild(row);
        }
        for (const ov of this.overlays) {
          if (r[ov.field] == null || this.hidden.has(ov.field)) continue;
          const orow = el('div', 'bc-row');
          orow.appendChild(el('span', null, ov.label));
          const ob = el('b', null, fmt(r[ov.field], this.unit === '%' ? 1 : 0) + this.unit);
          ob.style.color = ov.color;
          orow.appendChild(ob);
          tip.appendChild(orow);
        }
        if (this.rawField && r[this.rawField] != null && !this.hidden.has('daily')) {
          const rw = el('div', 'bc-row');
          rw.appendChild(el('span', null, 'daily'));
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
      if (this.onHover) this.onHover(this.hover);
    }

    _onLeave() {
      this.hover = -1;
      if (this.tooltip) this.tooltip.style.display = 'none';
      this._draw();
      if (this.onLeave) this.onLeave();
    }

    // Externally-driven hover (from the cross-chart sync). Does NOT re-broadcast.
    setHover(i) {
      const n = this.data.length;
      if (i == null || i < 0 || n === 0) { this.clearHover(); return; }
      this.hover = Math.max(0, Math.min(n - 1, i));
      this._draw();
    }

    clearHover() {
      this.hover = -1;
      if (this.tooltip) this.tooltip.style.display = 'none';
      this._draw();
    }

    // Toggle which lines are drawn (keys: main field name, overlay field names,
    // or 'daily'). The y-scale re-fits to whatever remains visible.
    setHidden(keys) {
      this.hidden = keys instanceof Set ? keys : new Set(keys || []);
      this._draw();
    }
  }

  window.BreadthChart = BreadthChart;
})();
