// ──────────────────────────────────────────────
// LPM — Bandar Metrics' Liquidity Pressure Model, reproduced (pure, no fetching)
// ──────────────────────────────────────────────
// Bandar Metrics publishes LPM as proprietary. This is the formula reverse-
// engineered from its published values: exact (to the digits shown) on 186
// stocks, including new listings from their first LPM day and stocks that went
// through splits/rights issues. For stock S on day d:
//
//   1. cut-off T(d)  = 75th percentile (linear) of daily lots/trades over the
//                      last 200 trading days INCLUDING d
//   2. a broker's buy side qualifies if its buy lots / buy trades >= T(d);
//      each sell side likewise (regular market, GROSS broker summary)
//   3. buyAvg = Σ lots / Σ trades over qualifying buy sides (0 if none);
//      sellAvg likewise
//   4. change(d) = k_S × close(d) × (buyAvg − sellAvg)
//   5. LPM(d)    = running sum of change from the first day
//
// k_S is a fixed per-stock scale (lib/lpm-constants.js) — it does not change
// the shape of a stock's line, only its height, so signals can use k = 1.
//
// ⚠️ INPUTS MUST BE GROSS, PER BROKER, WITH TRADE COUNTS. A net broker summary
// (one side per broker, e.g. GoAPI's, see foreign.js) cannot produce LPM: the
// qualification test needs each broker's buy lots/trades and sell lots/trades
// separately. Stockbit's `/marketdetectors/{code}` with TRANSACTION_TYPE_GROSS,
// MARKET_BOARD_REGULER is the source the formula was verified against.
//
// Rules found on the way, each verified on published data:
//   - New listing: LPM starts on the trading day AFTER listing; the listing day
//     is never in the window (pass `startIndex: 1`).
//   - Corporate actions: Bandar Metrics keeps RAW lots/trade in the window, so a
//     split-adjusted history must be un-adjusted (`actions`, see lpm-constants).
//   - Close price, not VWAP or brokers' average price (those miss by ~0.5%).
//   - History is never recalculated; values before ~19 Aug 2020 match Stockbit
//     data, values from then until ~late 2022 were built from a broker feed that
//     differs from Stockbit's today, so they cannot be reproduced from it.

export const WINDOW = 200;
export const PERCENTILE = 75;

/** Linear-interpolated percentile (numpy's default), p in 0..100. */
export function percentile(values, p) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * p / 100;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Lots per trade for each window day, un-adjusting corporate actions: a window
 * day before an action's date is divided by its ratio once `onDate` is on/after
 * that date. `days` = [{ date, lots, trades }], ascending.
 */
export function windowLotsPerTrade(days, onDate, actions = []) {
  return days
    .filter(d => d.trades > 0)
    .map(d => {
      let ratio = 1;
      for (const a of actions) if (d.date < a.date && a.date <= onDate) ratio *= a.ratio;
      return d.lots / d.trades / ratio;
    });
}

/** T(d): the big-ticket cut-off, from the window's lots per trade. */
export function cutoff(lotsPerTrade) {
  return percentile(lotsPerTrade, PERCENTILE);
}

/** Pooled average ticket over the sides at or above the cut-off; 0 if none. */
export function pooledAverage(sides, T) {
  let lots = 0, trades = 0;
  for (const s of sides) {
    if (s.trades > 0 && s.lots / s.trades >= T) { lots += s.lots; trades += s.trades; }
  }
  return trades ? lots / trades : 0;
}

/**
 * One day's LPM change. `window` = lots/trade for the last 200 trading days
 * including today (already un-adjusted); `buy`/`sell` = [{ lots, trades }] per
 * broker, regular market, gross.
 */
export function lpmDay({ k = 1, close, window, buy, sell }) {
  const T = cutoff(window);
  const buyAvg = pooledAverage(buy, T);
  const sellAvg = pooledAverage(sell, T);
  return { cutoff: T, buyAvg, sellAvg, change: k * close * (buyAvg - sellAvg) };
}

/**
 * A whole series. `days` = [{ date, close, lots, trades }] ascending (Stockbit
 * daily history); `summaries` = { date: { buy, sell } }. Days without a broker
 * summary are skipped (they add nothing; the running sum carries over).
 * `startIndex` = 1 for a stock listed inside `days` (listing day excluded).
 */
export function lpmSeries({ k = 1, days, summaries, actions = [], startIndex = 0, window: W = WINDOW }) {
  const out = [];
  let lpm = 0;
  for (let i = startIndex; i < days.length; i++) {
    const d = days[i];
    const bs = summaries[d.date];
    if (!bs || !(d.trades > 0)) continue;
    const win = windowLotsPerTrade(days.slice(Math.max(startIndex, i - W + 1), i + 1), d.date, actions);
    const day = lpmDay({ k, close: d.close, window: win, buy: bs.buy, sell: bs.sell });
    lpm += day.change;
    out.push({ date: d.date, ...day, lpm });
  }
  return out;
}

/** Read a stock's k from one published day: actual change / unscaled change. */
export function constantFromDay({ actualChange, close, buyAvg, sellAvg }) {
  const unscaled = close * (buyAvg - sellAvg);
  return unscaled ? actualChange / unscaled : NaN;
}
