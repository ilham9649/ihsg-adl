// ──────────────────────────────────────────────
// The session ledger — every stock's close and running volume/value, per session
// ──────────────────────────────────────────────
// Pure, like movers.js: the breadth refresh feeds each ticker's bars in as it
// goes (index.js: refreshData), so this costs no Yahoo call.
//
// What it answers: the top gainers, losers, value and volume across the WHOLE
// listing, for one session or any date range. Storing each day's top 20 can't
// do a range — a stock 25th every day can be the month's best and never show —
// so each session keeps every stock instead, as
//
//   { ticker: [close, cumVolume, cumValue, ageDays] }
//
// close    — the last close on or before the session (raw close, as traded;
//            Yahoo's raw close is still split-adjusted)
// cum*     — running totals since the ledger's first bar. A range's volume is
//            then the end session's total minus the one before the range,
//            whatever its length: two items read, not one per session.
// ageDays  — calendar days since that close (0 = traded that session).
//
// Value is close × volume, an approximation: IDX's value is each trade's own
// price, which this has no access to. The page says "≈".
//
// Price % compares the range's last close with the close before it starts,
// and only when that starting close is live: a stock that hadn't traded for
// over MAX_BAR_GAP_DAYS before the range reopens ±70% on resumption, which is
// a gap, not a gain (same rule as isStaleComparison). A stock that didn't
// trade at all in the range is in no list.

import { isStaleComparison } from './yahoo.js';

export const TOP_N = 20;

const DAY_MS = 86400000;
const ageDays = (from, to) => Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / DAY_MS);
const minusDays = (date, n) => new Date(new Date(date + 'T00:00:00Z').getTime() - n * DAY_MS).toISOString().slice(0, 10);
const round2 = v => Math.round(v * 100) / 100;

/**
 * An accumulator over the given session dates (ascending — the index's own
 * calendar, so every stock is read on the same days).
 *   add(ticker, quotes)  — quotes: [{ date, close, volume }] ascending; bars
 *                          before the first session set the opening close
 *   result()             — Map(date → { ticker: [close, cumVol, cumValue, ageDays] })
 */
export function createLedger(sessions) {
  const days = new Map(sessions.map(d => [d, {}]));
  const first = sessions[0];
  return {
    add(ticker, quotes) {
      // A stock with no bar inside the window is not in it (delisted, long halted).
      if (!first || !quotes.length || quotes[quotes.length - 1].date < first) return;
      let q = 0, close = null, closeDate = null, cumVol = 0, cumVal = 0;
      for (const date of sessions) {
        for (; q < quotes.length && quotes[q].date <= date; q++) {
          const bar = quotes[q];
          if (!(bar.close > 0)) continue;
          close = bar.close;
          closeDate = bar.date;
          if (bar.volume > 0) {
            cumVol += bar.volume;
            cumVal += bar.close * bar.volume;
          }
        }
        if (close != null) days.get(date)[ticker] = [close, cumVol, Math.round(cumVal), ageDays(closeDate, date)];
      }
    },
    result() { return days; },
  };
}

/**
 * The sessions a range covers on the ledger's calendar: `base` is the session
 * before the range (its closing prices and totals are the starting line),
 * `end` the last session on or before `to`. A range reaching back past the
 * ledger starts at its second session — the first one is only a baseline.
 * Null when no session falls inside.
 */
export function ledgerSpan(dates, from, to) {
  let base = -1, end = -1;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] < from) base = i;
    if (dates[i] <= to) end = i;
  }
  if (base < 0) base = 0;
  if (end <= base) return null;
  return { base: dates[base], from: dates[base + 1], to: dates[end], sessions: end - base };
}

/**
 * Rank the stocks between two ledger sessions. `base` may be null (nothing
 * before), in which case nothing has a price move, only volume and value.
 * Returns { gain, lose, value, volume }, each up to n rows of
 * [ticker, close, pct, value, volume] — pct null when there's no live start.
 */
// A stock's price move between two ledger sessions, or null without a live
// starting close (see the header).
function moveBetween(b, close, baseDate) {
  const live = b && b[0] > 0 && (!baseDate || !isStaleComparison(minusDays(baseDate, b[3]), baseDate));
  return live ? round2((close / b[0] - 1) * 100) : null;
}

/** Every stock's price move between two ledger sessions: { ticker: pct }, live starts only. */
export function ledgerMoves(base, end, { baseDate } = {}) {
  const out = {};
  for (const [ticker, [close]] of Object.entries(end)) {
    const pct = moveBetween(base?.[ticker], close, baseDate);
    if (pct != null) out[ticker] = pct;
  }
  return out;
}

export function rankLedger(base, end, { baseDate, n = TOP_N } = {}) {
  const rows = [];
  for (const [ticker, [close, cumVol, cumVal]] of Object.entries(end)) {
    const b = base?.[ticker];
    const volume = cumVol - (b ? b[1] : 0);
    if (!(volume > 0)) continue;
    const value = cumVal - (b ? b[2] : 0);
    rows.push([ticker, close, moveBetween(b, close, baseDate), value, volume]);
  }
  const top = (keep, key) => rows.filter(keep).sort((a, b) => key(b) - key(a)).slice(0, n);
  return {
    gain: top(r => r[2] > 0, r => r[2]),
    lose: top(r => r[2] < 0, r => -r[2]),
    value: top(() => true, r => r[3]),
    volume: top(() => true, r => r[4]),
  };
}
