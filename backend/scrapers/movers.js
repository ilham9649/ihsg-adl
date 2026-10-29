// ──────────────────────────────────────────────
// Index movers — which stocks moved the IHSG, in index points
// ──────────────────────────────────────────────
// Pure computation only (no fetching), like ma200w.js: the daily refresh hands
// in the bars it already fetched for breadth, plus each ticker's share counts
// (index.js: refreshData).
//
// The IHSG is Σ(price × shares × free float) / divisor, so on any session a
// stock's push on the index is its weight going in times its own return:
//
//     points = IHSG(previous close) × weight(previous close) × return(today)
//
// and the points across the constituents add up to the day's move — as far as
// our weights match IDX's. They are an ESTIMATE rebuilt from public data:
// Yahoo share counts, a free-float table (lib/freefloat.js) with dated
// corrections, and IDX's HSC exclusion list (both in lib/ihsg-rules.js).
// Every day carries its estimated total beside
// the real move, so the gap is on the record rather than hidden.
//
// Free float is not optional. Over 2025-09 → 2026-10, full market-cap weights
// missed the real daily move by 14 points on average and told the wrong story
// on the days that matter: on 2026-05-29 the IHSG fell 2.8 points, and full
// market cap had BREN lifting it by 53 (an estimated +63 day). Float weights
// missed by 7 points on average, and had that day at −3.8, led by BBCA.
//
// Raw close, not adjusted — unlike breadth (yahoo.js). The IHSG is a price
// index and really does drop when a heavyweight goes ex-dividend; adjClose
// would invent a move the index never made. Yahoo's raw close is still
// split-adjusted, which is right: IDX re-bases the divisor on a split.

import { isStaleComparison, MAX_BAR_GAP_DAYS } from './yahoo.js';
import { FREE_FLOAT } from '../lib/freefloat.js';
import { hscExcludedOn, floatOverrideOn } from '../lib/ihsg-rules.js';

export const MOVERS_SESSIONS = 252; // one trading year — the window the estimate was checked over
export const MOVERS_PER_SIDE = 5;
export const WEIGHT_CAP = 0.09;     // IDX caps any one constituent at 9% of the index

// A code missing from the table takes the median ratio. Those are almost all
// small names whose weight rounds to nothing either way.
export const DEFAULT_FREE_FLOAT = (() => {
  const v = Object.values(FREE_FLOAT).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0.25;
})();

const round2 = v => Math.round(v * 100) / 100;

/**
 * Shares outstanding on `date`, from filings sorted oldest first: the latest
 * filing on or before it. A date before the first filing Yahoo still serves
 * takes that first filing — the nearest figure there is.
 */
export function sharesOn(filings, date) {
  if (!filings?.length) return null;
  let value = filings[0].value;
  for (const f of filings) {
    if (f.date > date) break;
    value = f.value;
  }
  return value;
}

/**
 * Cap any weight above `cap` and hand the excess to the uncapped names pro
 * rata — how IDX keeps BBCA/BBRI at 9%. Repeats because the hand-out can push
 * another name over. Weights sum to 1 going in and coming out.
 */
export function capWeights(weights, cap = WEIGHT_CAP) {
  const w = weights.slice();
  if (!(cap > 0) || w.length * cap < 1) return w; // no cap could hold — leave as is
  const capped = new Array(w.length).fill(false);
  for (;;) {
    let excess = 0;
    for (let i = 0; i < w.length; i++) {
      if (!capped[i] && w[i] > cap) { excess += w[i] - cap; w[i] = cap; capped[i] = true; }
    }
    if (excess <= 1e-12) return w;
    let free = 0;
    for (let i = 0; i < w.length; i++) if (!capped[i]) free += w[i];
    if (!(free > 0)) return w;
    for (let i = 0; i < w.length; i++) if (!capped[i]) w[i] += excess * w[i] / free;
  }
}

// Each ticker's close on every index session. A stock that didn't trade keeps
// its last close (a halted stock stays in the index at its last price, moving
// it by nothing) — but only across a short gap, the same 30 days breadth uses.
function alignCloses(bars, sessions) {
  const px = new Array(sessions.length).fill(null);
  let j = 0, last = null;
  for (let k = 0; k < sessions.length; k++) {
    while (j < bars.length && bars[j].date <= sessions[k].date) last = bars[j++];
    if (last?.close > 0 && !isStaleComparison(last.date, sessions[k].date)) px[k] = last.close;
  }
  return px;
}

/**
 * The earliest bar computeMovers can use: the session before the window, less
 * the longest gap a close is carried across. index.js trims each ticker's
 * 16-year history to this before holding it for the whole scrape.
 */
export function moversHistoryStart(indexBars, sessions = MOVERS_SESSIONS) {
  const first = indexBars[Math.max(0, indexBars.length - sessions - 1)];
  if (!first) return null;
  const d = new Date(first.date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - MAX_BAR_GAP_DAYS);
  return d.toISOString().slice(0, 10);
}

/**
 * Per-session attribution for the last `sessions` IHSG sessions.
 *
 * indexBars: [{ date, close }] ascending — the IHSG itself, also the calendar.
 * tickers:   [{ ticker, bars: [{ date, close }] ascending, shares: [{ date, value }] ascending }]
 *
 * Returns, oldest first:
 *   { date, change, pct, estimate, up, down, rest, counted }
 * change/pct are the REAL move; estimate is what the weights add up to; up and
 * down are the biggest lifters and draggers ({ ticker, pts, pct }); rest is
 * the net of every other constituent, so up + down + rest = estimate.
 */
export function computeMovers(indexBars, tickers, {
  sessions = MOVERS_SESSIONS,
  perSide = MOVERS_PER_SIDE,
  freeFloat = FREE_FLOAT,
  defaultFloat = DEFAULT_FREE_FLOAT,
  excludedOn = hscExcludedOn,
  floatOn = floatOverrideOn,
  weightCap = WEIGHT_CAP,
} = {}) {
  const cal = indexBars.filter(b => b.close > 0).slice(-(sessions + 1));
  if (cal.length < 2) return [];

  const series = tickers.map(t => ({
    ticker: t.ticker,
    px: alignCloses(t.bars, cal),
    shares: t.shares,
    float: freeFloat[t.ticker] ?? defaultFloat,
  }));

  const days = [];
  for (let k = 1; k < cal.length; k++) {
    const date = cal[k].date;
    // Membership is the session's own: HSC names leave from their effective date.
    const excluded = excludedOn(date);
    const rows = [];
    let total = 0;
    for (const s of series) {
      const p0 = s.px[k - 1], p1 = s.px[k];
      if (!(p0 > 0) || !(p1 > 0) || excluded.has(s.ticker)) continue;
      const shares = sharesOn(s.shares, cal[k - 1].date);
      if (!(shares > 0)) continue;
      const cap = shares * (floatOn(s.ticker, cal[k - 1].date) ?? s.float) * p0;
      rows.push({ ticker: s.ticker, cap, ret: p1 / p0 - 1 });
      total += cap;
    }
    if (!(total > 0)) continue;

    const base = cal[k - 1].close;
    const weights = capWeights(rows.map(r => r.cap / total), weightCap);
    let estimate = 0;
    rows.forEach((r, i) => { r.pts = base * weights[i] * r.ret; estimate += r.pts; });

    const ranked = rows.slice().sort((a, b) => b.pts - a.pts);
    const up = ranked.filter(r => r.pts > 0).slice(0, perSide);
    const down = ranked.filter(r => r.pts < 0).reverse().slice(0, perSide);
    const shown = [...up, ...down].reduce((sum, r) => sum + r.pts, 0);
    const mover = r => ({ ticker: r.ticker, pts: round2(r.pts), pct: round2(r.ret * 100) });

    days.push({
      date,
      change: round2(cal[k].close - base),
      pct: round2((cal[k].close / base - 1) * 100),
      estimate: round2(estimate),
      up: up.map(mover),
      down: down.map(mover),
      rest: round2(estimate - shown),
      counted: rows.length,
    });
  }
  return days;
}
