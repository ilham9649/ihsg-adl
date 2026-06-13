// ──────────────────────────────────────────────
// BreadthChart — dependency-free two-panel canvas chart
//   top panel:    IHSG index candlesticks (OHLC)
//   bottom panel: cumulative Advance/Decline Line (area)
// Shared time axis, crosshair tooltip. No build step, no plugins.
// ──────────────────────────────────────────────
(function () {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  class BreadthChart {
    constructor(canvas, tooltip) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.tooltip = tooltip || null;
      this.data = [];
      this.dpr = Math.max(1, window.devicePixelRatio || 1);
      this.hover = -1;

      // layout
      this.padR = 60;   // right axis labels
      this.padL = 12;
      this.padT = 14;
      this.padB = 26;
      this.gap = 18;    // gap between panels
      this.split = 0.64; // top panel share

      // theme
      this.col = {
        grid: 'rgba(255,255,255,0.05)',
        axis: '#5b6b7e',
        text: '#8899aa',
        up: '#22c55e',
        down: '#ef4444',
        line: '#c9a96e',
        fill: 'rgba(201,169,110,0.14)',
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
      // rows: [{date, ihsgOpen, ihsgHigh, ihsgLow, ihsg, adLine}, ...] ascending
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
      const w = c.clientWidth, h = c.clientHeight || 360;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      this.w = w; this.h = h;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._draw();
    }

    _panels() {
      const plotW = this.w - this.padL - this.padR;
      const plotH = this.h - this.padT - this.padB;
      const topH = plotH * this.split;
      const botH = plotH - topH - this.gap;
      return {
        plotW,
        top: { x: this.padL, y: this.padT, w: plotW, h: topH },
        bot: { x: this.padL, y: this.padT + topH + this.gap, w: plotW, h: botH },
      };
    }

    _xAt(i, n, p) {
      return p.x + (i + 0.5) * (p.w / n);
    }

    _scale(domainMin, domainMax, pxH) {
      const pad = (domainMax - domainMin) * 0.06 || 1;
      const lo = domainMin - pad, hi = domainMax + pad;
      return { lo, hi, y: (v) => pxH * (hi - v) / (hi - lo) };
    }

    _draw() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      const rows = this.data;
      const P = this._panels();
      if (rows.length === 0) {
        ctx.fillStyle = this.col.text;
        ctx.font = '13px IBM Plex Sans, sans-serif';
        ctx.fillText('No data', this.padL + 8, this.h / 2);
        return;
      }
      const n = rows.length;

      const hiArr = rows.map(r => r.ihsgHigh ?? r.ihsg ?? null).filter(v => v != null);
      const loArr = rows.map(r => r.ihsgLow ?? r.ihsg ?? null).filter(v => v != null);
      const adArr = rows.map(r => r.adLine).filter(v => v != null);
      const hasCandles = rows.some(r => r.ihsgOpen != null && r.ihsgHigh != null);
      const topScale = (hasCandles && hiArr.length)
        ? this._scale(Math.min(...loArr), Math.max(...hiArr), P.top.h)
        : null;
      const botScale = adArr.length ? this._scale(Math.min(...adArr), Math.max(...adArr), P.bot.h) : null;

      this._drawGrid(P);
      if (topScale) this._drawCandles(rows, n, P.top, topScale);
      if (botScale) this._drawADLine(rows, n, P.bot, botScale);
      this._drawAxes(P, topScale, botScale, n);
      if (this.hover >= 0 && this.hover < n) this._drawCrosshair(rows, P, topScale, botScale, n);
    }

    _drawGrid(P) {
      const ctx = this.ctx;
      ctx.strokeStyle = this.col.grid;
      ctx.lineWidth = 1;
      for (const pan of [P.top, P.bot]) {
        ctx.beginPath();
        for (let g = 0; g <= 4; g++) {
          const y = Math.round(pan.y + (pan.h * g) / 4) + 0.5;
          ctx.moveTo(pan.x, y); ctx.lineTo(pan.x + pan.w, y);
        }
        ctx.stroke();
      }
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

    _drawAxes(P, topScale, botScale, n) {
      const ctx = this.ctx;
      ctx.fillStyle = this.col.text;
      ctx.font = '11px IBM Plex Mono, monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      if (topScale) {
        for (const t of this._niceTicks(topScale.lo, topScale.hi, 4)) {
          const y = P.top.y + topScale.y(t);
          if (y < P.top.y || y > P.top.y + P.top.h) continue;
          ctx.fillText(this._fmt(t), P.top.x + P.top.w + 6, y);
        }
      }
      if (botScale) {
        for (const t of this._niceTicks(botScale.lo, botScale.hi, 4)) {
          const y = P.bot.y + botScale.y(t);
          if (y < P.bot.y || y > P.bot.y + P.bot.h) continue;
          ctx.fillText(this._fmt(t), P.bot.x + P.bot.w + 6, y);
        }
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const want = Math.min(8, n);
      for (let k = 0; k < want; k++) {
        const i = Math.floor((k + 0.5) * n / want);
        const x = this._xAt(i, n, P.bot);
        ctx.fillText(this.data[i].date.slice(5), x, P.bot.y + P.bot.h + 6);
      }

      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = this.col.axis;
      ctx.font = '600 10px IBM Plex Sans, sans-serif';
      ctx.fillText('IHSG', P.top.x + 4, P.top.y + 2);
      ctx.fillStyle = this.col.line;
      ctx.fillText('A/D LINE', P.bot.x + 4, P.bot.y + 2);
    }

    _drawCandles(rows, n, pan, scale) {
      const ctx = this.ctx;
      const cw = Math.max(1, (pan.w / n) * 0.7);
      for (let i = 0; i < n; i++) {
        const r = rows[i];
        if (r.ihsgOpen == null || r.ihsgHigh == null || r.ihsgLow == null || r.ihsg == null) continue;
        const x = this._xAt(i, n, pan);
        const up = r.ihsg >= r.ihsgOpen;
        const col = up ? this.col.up : this.col.down;
        const wick = up ? this.col.wickUp : this.col.wickDown;
        const yO = pan.y + scale.y(r.ihsgOpen);
        const yC = pan.y + scale.y(r.ihsg);
        const yH = pan.y + scale.y(r.ihsgHigh);
        const yL = pan.y + scale.y(r.ihsgLow);
        ctx.strokeStyle = wick; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
        ctx.fillStyle = col;
        const top = Math.min(yO, yC), h = Math.max(1, Math.abs(yC - yO));
        ctx.fillRect(x - cw / 2, top, cw, h);
      }
    }

    _drawADLine(rows, n, pan, scale) {
      const ctx = this.ctx;
      const pts = [];
      for (let i = 0; i < n; i++) {
        if (rows[i].adLine == null) continue;
        pts.push([this._xAt(i, n, pan), pan.y + scale.y(rows[i].adLine)]);
      }
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pan.y + pan.h);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.lineTo(pts[pts.length - 1][0], pan.y + pan.h);
      ctx.closePath();
      ctx.fillStyle = this.col.fill;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.strokeStyle = this.col.line;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    _drawCrosshair(rows, P, topScale, botScale, n) {
      const ctx = this.ctx;
      const i = this.hover;
      const r = rows[i];
      const x = this._xAt(i, n, P.top);
      ctx.strokeStyle = this.col.cross;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, P.top.y); ctx.lineTo(x, P.bot.y + P.bot.h);
      ctx.stroke();
      ctx.setLineDash([]);
      if (topScale && r.ihsg != null) {
        const y = P.top.y + topScale.y(r.ihsg);
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = this.col.line; ctx.fill();
      }
      if (botScale && r.adLine != null) {
        const y = P.bot.y + botScale.y(r.adLine);
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = this.col.line; ctx.fill();
      }
      this._updateTooltip(r, x);
    }

    // Safe DOM tooltip (no innerHTML / no XSS surface).
    _updateTooltip(r, x) {
      if (!this.tooltip) return;
      const tip = this.tooltip;
      tip.replaceChildren();
      const fmt = (v, d = 2) => v == null ? '—' : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
      tip.appendChild(el('div', 'bc-date', r.date));

      const priceRow = el('div', 'bc-row');
      priceRow.appendChild(el('span', null, 'IHSG'));
      priceRow.appendChild(el('b', null, fmt(r.ihsg, 0)));
      tip.appendChild(priceRow);

      if (r.ihsgOpen != null) {
        const ohlc1 = el('div', 'bc-row');
        ohlc1.appendChild(el('span', null, 'O ' + fmt(r.ihsgOpen, 0)));
        ohlc1.appendChild(el('span', null, 'H ' + fmt(r.ihsgHigh, 0)));
        tip.appendChild(ohlc1);
        const ohlc2 = el('div', 'bc-row');
        ohlc2.appendChild(el('span', null, 'L ' + fmt(r.ihsgLow, 0)));
        ohlc2.appendChild(el('span', null, 'C ' + fmt(r.ihsg, 0)));
        tip.appendChild(ohlc2);
        const chg = r.ihsgOpen ? ((r.ihsg - r.ihsgOpen) / r.ihsgOpen * 100) : null;
        const chgRow = el('div', 'bc-row');
        chgRow.appendChild(el('span', null, 'chg'));
        const cb = el('b', null, (chg >= 0 ? '+' : '') + (chg != null ? chg.toFixed(2) : '—') + '%');
        if (chg != null) cb.style.color = chg >= 0 ? this.col.up : this.col.down;
        chgRow.appendChild(cb);
        tip.appendChild(chgRow);
      }

      const adRow = el('div', 'bc-row');
      adRow.appendChild(el('span', null, 'A/D Line'));
      const ab = el('b', null, fmt(r.adLine, 0));
      ab.style.color = this.col.line;
      adRow.appendChild(ab);
      tip.appendChild(adRow);

      tip.style.display = 'block';
      const tw = tip.offsetWidth;
      let left = x + 14;
      if (left + tw > this.w - 4) left = x - tw - 14;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = '10px';
    }

    _fmt(v) {
      if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k';
      return Number(v).toFixed(0);
    }

    _onMove(e) {
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const plot = this._panels().top; // plot.x == padL, plot.w == plotW
      const n = this.data.length;
      if (n === 0) return;
      const i = Math.round((px - plot.x) / (plot.w / n) - 0.5);
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
