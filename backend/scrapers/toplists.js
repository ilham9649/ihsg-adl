// ──────────────────────────────────────────────
// Session top lists — gainers, losers, value and volume, across the listing
// ──────────────────────────────────────────────
// Pure, like movers.js: the breadth refresh feeds each ticker's bars in as it
// goes (index.js: refreshData), so this costs no Yahoo call. Where the movers
// rank by index points (who moved the IHSG), these rank the whole listing by
// its own numbers — a 30% micro-cap that barely touches the index tops this.
//
// Raw close, as traded (Yahoo's raw close is still split-adjusted): a price
// move is what a gainers list reports. A session compared against a close
// more than MAX_BAR_GAP_DAYS old is skipped — a stock back from suspension
// often reopens ±70%, which is a gap, not a gain. So is any session with no
// volume: nothing traded, so nothing gained.
//
// Value is close × volume, an approximation: IDX's value is each trade's own
// price, which this has no access to. The page says "≈".

import { isStaleComparison } from './yahoo.js';

export const TOP_N = 20;
export const TOP_LISTS = ['gain', 'lose', 'value', 'volume'];

// Each list's sort key, biggest first: a row is [ticker, close, pct, value, volume].
const KEY = { gain: r => r[2], lose: r => -r[2], value: r => r[3], volume: r => r[4] };

const round2 = v => Math.round(v * 100) / 100;

/**
 * An accumulator over the sessions from `from` (YYYY-MM-DD) on.
 *   add(ticker, quotes)  — quotes: [{ date, close, volume }] ascending
 *   result()             — { date: { gain, lose, value, volume } }, each list
 *                          up to n rows of [ticker, close, pct, value, volume]
 */
export function createTopLists(from, n = TOP_N) {
  const days = new Map(); // date → { gain: [], lose: [], value: [], volume: [] }

  // Keep each list sorted and capped: an insert costs a scan of n ≤ 20.
  const offer = (list, row, key) => {
    const k = key(row);
    if (list.length === n && k <= key(list[n - 1])) return;
    let i = list.length;
    while (i > 0 && key(list[i - 1]) < k) i--;
    list.splice(i, 0, row);
    if (list.length > n) list.pop();
  };

  return {
    add(ticker, quotes) {
      for (let k = 1; k < quotes.length; k++) {
        const q = quotes[k], p = quotes[k - 1];
        if (q.date < from || !(q.volume > 0) || !(q.close > 0) || !(p.close > 0)) continue;
        if (isStaleComparison(p.date, q.date)) continue;
        const row = [ticker, q.close, round2((q.close / p.close - 1) * 100), Math.round(q.close * q.volume), q.volume];
        let day = days.get(q.date);
        if (!day) days.set(q.date, day = { gain: [], lose: [], value: [], volume: [] });
        if (row[2] > 0) offer(day.gain, row, KEY.gain);
        if (row[2] < 0) offer(day.lose, row, KEY.lose);
        offer(day.value, row, KEY.value);
        offer(day.volume, row, KEY.volume);
      }
    },
    result() {
      return Object.fromEntries([...days.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },
  };
}
