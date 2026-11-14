// ──────────────────────────────────────────────
// Bandarmology — broker-flow readings per stock (pure, no fetching)
// ──────────────────────────────────────────────
// Four readings, each reproduced from Bandar Metrics' published series and
// computed here from Stockbit data (daily history + regular-market GROSS broker
// summary; see jobs/bandarmology/ for the fetch):
//
//   LPM              scrapers/lpm.js, with k = 1. Bandar Metrics' per-stock
//                    constant only sets the height of the line, so the page
//                    shows the shape (scale-free) and never their numbers.
//   Volume Rotation  total lots / (Σ over brokers |buy lots − sell lots| / 2):
//                    how many times the day's volume turned over relative to
//                    the net amount that actually changed hands between
//                    brokers. High = churn, low = one-way flow.
//   Intensity        daily volume (shares) / trades⁴ — Bandar Metrics'
//                    definition, kept as is. Read only against the stock's own
//                    history (z-score of its log).
//   Foreign Flow     running sum of Stockbit's daily net foreign value (rupiah).
//
// Backtest (research/lpm-backtest-results.md): none of these, LPM included,
// reliably predicted returns over 2023–2026. The page describes flows; it does
// not forecast.

import { lpmSeries } from './lpm.js';

export const Z_WINDOW = 250;     // sessions of a stock's own history a z-score uses, at most
export const MIN_Z_HISTORY = 60; // fewer than this and no z-score is given
export const CHANGE_DAYS = 20;

/** Volume Rotation from one day's gross broker summary. */
export function volumeRotation(buy, sell) {
  const net = new Map();
  let total = 0;
  for (const b of buy) { net.set(b.broker, (net.get(b.broker) || 0) + b.lots); total += b.lots; }
  for (const s of sell) net.set(s.broker, (net.get(s.broker) || 0) - s.lots);
  let moved = 0;
  for (const v of net.values()) moved += Math.abs(v);
  return moved > 0 ? total / (moved / 2) : null;
}

/** Bandar Metrics' Intensity: volume in shares over trades to the fourth. */
export function intensity(lots, trades) {
  return trades > 0 && lots > 0 ? (lots * 100) / trades ** 4 : null;
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

/** z-score of the last value against up to Z_WINDOW of its own past (incl. itself). */
export function lastZ(values) {
  const v = values.filter(x => x != null && Number.isFinite(x)).slice(-Z_WINDOW);
  if (v.length < MIN_Z_HISTORY) return null;
  const s = sd(v);
  return s > 0 ? (v[v.length - 1] - mean(v)) / s : null;
}

/**
 * A change over `days` sessions, in units of the series' own daily-change
 * volatility — so stocks of any size and any LPM scale compare directly.
 */
export function changeZ(series, days = CHANGE_DAYS) {
  if (series.length <= days) return null;
  const ch = [];
  for (let i = 1; i < series.length; i++) ch.push(series[i] - series[i - 1]);
  const recent = ch.slice(-Z_WINDOW);
  if (recent.length < MIN_Z_HISTORY) return null;
  const s = sd(recent);
  return s > 0 ? (series[series.length - 1] - series[series.length - 1 - days]) / (s * Math.sqrt(days)) : null;
}

/**
 * One stock → its chart series and its summary row.
 *   days      [{ date, open, high, low, close, lots, trades, value, netForeign }] ascending
 *   summaries { date: { buy: [{ broker, lots, trades }], sell: [...] } }
 *   actions   [{ date, ratio }] corporate actions (un-adjusts the LPM window)
 *   listed    true if the first row of `days` is the listing day
 * The series covers the days that have a broker summary; LPM and Foreign Flow
 * both start at 0 on the first of them.
 */
export function buildStock({ code, days, summaries, actions = [], listed = false }) {
  const lpm = lpmSeries({ k: 1, days, summaries, actions, startIndex: listed ? 1 : 0 });
  const byDate = new Map(days.map(d => [d.date, d]));
  let flow = 0;
  const series = lpm.map(p => {
    const d = byDate.get(p.date);
    flow += d.netForeign || 0;
    const bs = summaries[p.date];
    return {
      date: p.date, close: d.close,
      lpm: p.lpm, lpmChange: p.change,
      flow, vr: volumeRotation(bs.buy, bs.sell),
      intensity: intensity(d.lots, d.trades),
    };
  });
  if (!series.length) return null;

  const last = series[series.length - 1];
  const closes = days.map(d => d.close);
  const iLast = days.findIndex(d => d.date === last.date);
  const ret = n => iLast >= n && closes[iLast - n] > 0 ? closes[iLast] / closes[iLast - n] - 1 : null;
  const value20 = days.slice(Math.max(0, iLast - 19), iLast + 1).map(d => d.value).sort((a, b) => a - b);
  const flow20 = series.length > CHANGE_DAYS ? last.flow - series[series.length - 1 - CHANGE_DAYS].flow : null;
  // Intensity's z uses the full daily history (it needs no broker data).
  const intens = days.slice(0, iLast + 1).map(d => intensity(d.lots, d.trades)).filter(v => v != null).map(Math.log);

  const row = {
    code, date: last.date, close: last.close,
    ret20: ret(CHANGE_DAYS),
    lpm20z: changeZ(series.map(s => s.lpm)),
    flow20, flow20z: changeZ(series.map(s => s.flow)),
    vr: last.vr, vrz: lastZ(series.map(s => s.vr)),
    intensityZ: lastZ(intens),
    valueMed20: value20.length ? value20[Math.floor(value20.length / 2)] : null,
  };
  // "Quiet accumulation": LPM up clearly over 20 sessions while the price is not.
  row.divergence = row.lpm20z != null && row.ret20 != null && row.lpm20z >= 1 && row.ret20 <= 0;
  return { row, series };
}
