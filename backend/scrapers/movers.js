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
// Yahoo share counts, dated free-float snapshots (the monthly freefloat job,
// over the frozen lib/freefloat.js baseline) with dated corrections, and IDX's
// HSC exclusion list (both in lib/ihsg-rules.js). Every day carries its
// estimated total beside the real move, so the gap is on the record rather
// than hidden.
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
import { FREE_FLOAT, FREE_FLOAT_AS_OF } from '../lib/freefloat.js';
import { hscExcludedOn, floatOverrideOn } from '../lib/ihsg-rules.js';

export const MOVERS_SESSIONS = 252; // one trading year — the window the estimate was checked over
export const MOVERS_PER_SIDE = 5;
export const RANGE_PER_SIDE = 10;   // a range spreads the move over more names, so it lists more
export const WEIGHT_CAP = 0.09;     // IDX caps any one constituent at 9% of the index

// The oldest float snapshot, committed in the repo. The monthly job's
// snapshots (DynamoDB, ff#YYYY-MM-DD) are laid over it by date; until one
// exists, this is all there is.
export const BASELINE_FLOATS = { date: FREE_FLOAT_AS_OF, floats: FREE_FLOAT };

// A code no snapshot covers takes the median ratio of the newest one. Those are
// almost all small names whose weight rounds to nothing either way.
function medianRatio(floats) {
  const v = Object.values(floats || {}).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0.25;
}

const round2 = v => Math.round(v * 100) / 100;

/**
 * The figure in force on `date`, from a dated series sorted oldest first —
 * share filings, or one code's float snapshots: the latest entry on or before
 * it. A date before the first entry takes that first entry, the nearest figure
 * there is.
 */
export function valueOn(series, date) {
  if (!series?.length) return null;
  let value = series[0].value;
  for (const f of series) {
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
 * floatSnapshots: [{ date, floats: { code: ratio } }], any order. A code keeps
 *   its float from the latest snapshot that has it, so a partial snapshot
 *   doesn't drop anyone.
 *
 * Returns, oldest first:
 *   { date, close, change, pct, estimate, up, down, rest, counted, m }
 * change/pct are the REAL move and close the IHSG's close; estimate is what
 * the weights add up to; up and down are the biggest lifters and draggers
 * ({ ticker, pts, pct }); rest is the net of every other constituent, so
 * up + down + rest = estimate. m holds EVERY constituent that moved the index
 * by at least 0.01 points, { ticker: [pts, pct] }, for aggregateMovers.
 */
export function computeMovers(indexBars, tickers, {
  sessions = MOVERS_SESSIONS,
  perSide = MOVERS_PER_SIDE,
  floatSnapshots = [BASELINE_FLOATS],
  excludedOn = hscExcludedOn,
  floatOn = floatOverrideOn,
  weightCap = WEIGHT_CAP,
} = {}) {
  const cal = indexBars.filter(b => b.close > 0).slice(-(sessions + 1));
  if (cal.length < 2) return [];

  const snapshots = floatSnapshots.slice().sort((a, b) => a.date.localeCompare(b.date));
  const defaultFloat = medianRatio(snapshots[snapshots.length - 1]?.floats);
  const series = tickers.map(t => ({
    ticker: t.ticker,
    px: alignCloses(t.bars, cal),
    shares: t.shares,
    floats: snapshots
      .filter(snap => snap.floats[t.ticker] != null)
      .map(snap => ({ date: snap.date, value: snap.floats[t.ticker] })),
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
      const asOf = cal[k - 1].date;
      const shares = valueOn(s.shares, asOf);
      if (!(shares > 0)) continue;
      const float = floatOn(s.ticker, asOf) ?? valueOn(s.floats, asOf) ?? defaultFloat;
      const cap = shares * float * p0;
      rows.push({ ticker: s.ticker, cap, ret: p1 / p0 - 1 });
      total += cap;
    }
    if (!(total > 0)) continue;

    const base = cal[k - 1].close;
    const weights = capWeights(rows.map(r => r.cap / total), weightCap);
    let estimate = 0;
    rows.forEach((r, i) => { r.pts = base * weights[i] * r.ret; estimate += r.pts; });

    const entries = rows.map(r => ({ ticker: r.ticker, pts: r.pts, pct: r.ret * 100 }));
    const m = {};
    for (const e of entries) {
      const pts = round2(e.pts);
      if (pts !== 0) m[e.ticker] = [pts, round2(e.pct)];
    }

    days.push({
      date,
      close: round2(cal[k].close),
      change: round2(cal[k].close - base),
      pct: round2((cal[k].close / base - 1) * 100),
      estimate: round2(estimate),
      ...rankMovers(entries, estimate, perSide),
      counted: rows.length,
      m,
    });
  }
  return days;
}

// The biggest lifters and draggers among `entries` ({ ticker, pts, pct }), and
// the net of everyone else — the same ranking for one session and for a range.
function rankMovers(entries, total, perSide) {
  const ranked = entries.slice().sort((a, b) => b.pts - a.pts);
  const up = ranked.filter(e => e.pts > 0).slice(0, perSide);
  const down = ranked.filter(e => e.pts < 0).reverse().slice(0, perSide);
  const shown = [...up, ...down].reduce((sum, e) => sum + e.pts, 0);
  const mover = e => ({ ticker: e.ticker, pts: round2(e.pts), pct: round2(e.pct) });
  return { up: up.map(mover), down: down.map(mover), rest: round2(total - shown) };
}

/**
 * The movers over a run of sessions, from and to inclusive — what a date range
 * on the page asks for. A stock's points ADD across sessions (each session's
 * points are its share of that day's move, and the day moves sum to the
 * range's), while its own price move COMPOUNDS. `days` are computeMovers'
 * sessions, carrying `m`. Null when no session falls in the range.
 *
 * The range's real move telescopes: the IHSG's last close less the close
 * before the first session (that session's close less its change).
 */
export function aggregateMovers(days, from, to, perSide = RANGE_PER_SIDE) {
  const span = days.filter(d => d.date >= from && d.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  if (!span.length) return null;

  const totals = new Map();
  let estimate = 0;
  for (const d of span) {
    estimate += d.estimate;
    for (const [ticker, [pts, pct]] of Object.entries(d.m || {})) {
      const t = totals.get(ticker) || { ticker, pts: 0, growth: 1 };
      t.pts += pts;
      t.growth *= 1 + pct / 100;
      totals.set(ticker, t);
    }
  }

  const first = span[0], last = span[span.length - 1];
  const base = first.close - first.change;
  const change = last.close - base;
  const entries = [...totals.values()].map(t => ({ ticker: t.ticker, pts: t.pts, pct: (t.growth - 1) * 100 }));
  return {
    from: first.date,
    to: last.date,
    sessions: span.length,
    change: round2(change),
    pct: round2((change / base) * 100),
    estimate: round2(estimate),
    ...rankMovers(entries, estimate, perSide),
    counted: totals.size,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = d => {
  if (!ISO_DATE.test(d)) return false;
  const t = new Date(d + 'T00:00:00Z');
  return !isNaN(t) && t.toISOString().startsWith(d); // rejects 2026-13-01 and 2026-02-30
};

/** A from/to pair from a request path: both real YYYY-MM-DD dates, put in order. Null otherwise. */
export function parseRange(from, to) {
  if (!isIsoDate(from) || !isIsoDate(to)) return null;
  return from <= to ? { from, to } : { from: to, to: from };
}

/** Every month (YYYY-MM) from `from` to `to` inclusive — the storage items a range reads. */
export function monthsSpanned(from, to) {
  const months = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [yEnd, mEnd] = to.slice(0, 7).split('-').map(Number);
  while (y < yEnd || (y === yEnd && m <= mEnd)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return months;
}
