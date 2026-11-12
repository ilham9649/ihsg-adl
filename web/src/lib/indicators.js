// ──────────────────────────────────────────────
// Breadth and momentum indicators, computed in the browser from /api/ad.
// Shared by the Breadth & Momentum page (which charts them) and anything
// else that reads the daily series.
// ──────────────────────────────────────────────

// Raw daily % Advancing is very noisy (each session is a fresh draw of ~950
// stocks), so the breadth line is smoothed with a trailing moving average.
// Computed over the FULL series (not the sliced range) so the visible window has
// no warmup gap. Tune the window here.
export const PCT_SMOOTH_WINDOW = 20;
// Moving averages of % Advancing drawn on the breadth line (data field → window).
export const PCT_MAS = { pctAdvancingMA: 20, pctAdvancingMA100: 100, pctAdvancingMA200: 200 };


// Attach a trailing SMA of pctAdvancing for each window, computed over the FULL
// series (so the visible range has no warmup gap). Uses whatever prior values
// exist (shorter effective window at the very start → no gaps).
export function attachPctSmoothing(rows) {
  const vals = rows.map(r => (r.pctAdvancing != null ? r.pctAdvancing : null));
  for (const [field, window] of Object.entries(PCT_MAS)) {
    for (let i = 0; i < rows.length; i++) {
      let sum = 0, cnt = 0;
      for (let k = Math.max(0, i - window + 1); k <= i; k++) {
        if (vals[k] != null) { sum += vals[k]; cnt++; }
      }
      rows[i][field] = cnt ? parseFloat((sum / cnt).toFixed(2)) : null;
    }
  }
}

// Zweig Breadth Thrust — a 10-day EMA of % Advancing. The signal is the climb
// from an oversold ≤40 reading to ≥61.5 within 10 sessions: a rare sign that a
// bottom was bought by the whole market rather than a few index heavyweights.
// Attaches `zbt` (the EMA), `thrust` (Zweig's 61.5 trigger) and `idxThrust`
// (the Jakarta rule: same climb, to 56). 56 came from a 2010–2026 backtest; see
// CLAUDE.md for why it is a watch level, not a proven signal.
export const THRUST_RULES = { thrust: 61.5, idxThrust: 56 };
export function attachThrust(rows, span = 10, low = 40) {
  const alpha = 2 / (span + 1);
  let ema = null, prev = null, lowAt = -1;
  rows.forEach((r, i) => {
    for (const f in THRUST_RULES) r[f] = false;
    if (r.pctAdvancing == null) { r.zbt = null; return; }
    ema = ema == null ? r.pctAdvancing : r.pctAdvancing * alpha + ema * (1 - alpha);
    r.zbt = parseFloat(ema.toFixed(2));
    if (ema <= low) lowAt = i;
    for (const [f, high] of Object.entries(THRUST_RULES)) {
      r[f] = prev != null && prev < high && ema >= high && lowAt >= 0 && i - lowAt <= span;
    }
    prev = ema;
  });
}

// ISO-week key for a YYYY-MM-DD date; and weekly OHLC bars of the IHSG index
// (shared by the weekly index oscillators below).
export function isoWeek(ds) {
  const dt = new Date(ds + 'T00:00:00Z');
  const day = (dt.getUTCDay() + 6) % 7;
  const th = new Date(dt); th.setUTCDate(dt.getUTCDate() - day + 3);
  const y = th.getUTCFullYear();
  const w = Math.floor((th - new Date(Date.UTC(y, 0, 1))) / (7 * 864e5)) + 1;
  return y + '-' + String(w).padStart(2, '0');
}
export function weeklyBars(rows) {
  const weeks = [], idx = {};
  for (const r of rows) {
    if (r.ihsg == null) continue;
    const k = isoWeek(r.date);
    let w = idx[k];
    if (!w) { w = idx[k] = { key: k, high: r.ihsgHigh ?? r.ihsg, low: r.ihsgLow ?? r.ihsg, close: r.ihsg }; weeks.push(w); }
    w.high = Math.max(w.high, r.ihsgHigh ?? r.ihsg);
    w.low = Math.min(w.low, r.ihsgLow ?? r.ihsg);
    w.close = r.ihsg;
  }
  return weeks;
}

// Weekly Stochastic (15,3,3) of the IHSG index, attached to each daily row (a
// long-horizon oversold/overbought gauge).
export function attachStochastic(rows, kLen = 15, kSmooth = 3, dSmooth = 3) {
  const weeks = weeklyBars(rows);
  const rawK = weeks.map((w, i) => {
    if (i < kLen - 1) return null;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kLen + 1; j <= i; j++) { hi = Math.max(hi, weeks[j].high); lo = Math.min(lo, weeks[j].low); }
    return hi > lo ? 100 * (w.close - lo) / (hi - lo) : 50;
  });
  const sma = (arr, n, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - n + 1); j <= i; j++) if (arr[j] != null) { s += arr[j]; c++; } return c ? s / c : null; };
  const K = rawK.map((v, i) => v == null ? null : sma(rawK, kSmooth, i));
  const D = K.map((v, i) => v == null ? null : sma(K, dSmooth, i));
  const wk = {};
  weeks.forEach((w, i) => { wk[w.key] = { K: K[i], D: D[i] }; });
  for (const r of rows) {
    const s = r.ihsg != null ? wk[isoWeek(r.date)] : null;
    r.stochK = s && s.K != null ? parseFloat(s.K.toFixed(1)) : null;
    r.stochD = s && s.D != null ? parseFloat(s.D.toFixed(1)) : null;
  }
}

// Weekly Shinohara Intensity Ratio (26) of the IHSG — the EXACT formula Yahoo
// Finance uses (from its ChartIQ study library), so our numbers match Yahoo's:
//   Strong Ratio = 100 · Σ(High − prevClose) / Σ(prevClose − Low)   over 26 weeks
//   Weak Ratio   = 100 · Σ(High − Close)     / Σ(Close − Low)       over 26 weeks
// Weak − Strong > 100 is a rare "extremely oversold" reading (a bottom signal).
export function attachShinohara(rows, period = 26) {
  const weeks = weeklyBars(rows);
  const val = {};
  for (let i = 0; i < weeks.length; i++) {
    if (i < period) { val[weeks[i].key] = { strong: null, weak: null }; continue; }
    let wn = 0, wd = 0, sn = 0, sd = 0;
    for (let k = i - period + 1; k <= i; k++) {
      const b = weeks[k], pc = weeks[k - 1].close;
      wn += b.high - b.close; wd += b.close - b.low;
      sn += b.high - pc; sd += pc - b.low;
    }
    val[weeks[i].key] = {
      strong: sd !== 0 ? parseFloat((100 * sn / sd).toFixed(1)) : null,
      weak: wd !== 0 ? parseFloat((100 * wn / wd).toFixed(1)) : null,
    };
  }
  for (const r of rows) {
    const v = r.ihsg != null ? val[isoWeek(r.date)] : null;
    r.shinStrong = v ? v.strong : null;
    r.shinWeak = v ? v.weak : null;
    // The reading IS the gap between the two ratios, so chart it directly
    // instead of asking the eye to measure a distance between two lines.
    r.shinSpread = (r.shinWeak != null && r.shinStrong != null)
      ? parseFloat((r.shinWeak - r.shinStrong).toFixed(1)) : null;
  }
}


/** Every indicator the pages chart, attached to each daily row in place. */
export function attachAll(rows) {
  attachPctSmoothing(rows);
  attachThrust(rows);
  attachStochastic(rows);
  attachShinohara(rows);
}
