// ──────────────────────────────────────────────
// 200-Week Moving Average — distance from support, per ticker
// ──────────────────────────────────────────────
// Pure computation only (no fetching) — the daily refresh piggybacks this on
// the per-ticker daily bars it already fetches for breadth (see index.js:
// refreshData), and the backfill script reuses it against a truncated bar
// array to answer "as of" a past date. Either way this module never touches
// the network.
//
// Weekly bucketing uses the SAME ISO-week convention as the frontend's weekly
// Stochastic/Shinohara panels (frontend/app.js: isoWeek/weeklyBars): a week's
// close is whatever the latest available daily close is, including a
// still-forming current week — not just fully "completed" weeks. Matching
// that convention (rather than adding a stricter one here) keeps "200 weeks"
// meaning the same thing everywhere in this codebase.

const MA_WEEKS = 200;

function isoWeek(dateStr) {
  const dt = new Date(dateStr + 'T00:00:00Z');
  const day = (dt.getUTCDay() + 6) % 7;
  const th = new Date(dt); th.setUTCDate(dt.getUTCDate() - day + 3);
  const y = th.getUTCFullYear();
  const w = Math.floor((th - new Date(Date.UTC(y, 0, 1))) / (7 * 86400000)) + 1;
  return y + '-' + String(w).padStart(2, '0');
}

/**
 * Weekly closes from ascending daily bars (fetchChart's output is already
 * sorted this way). Uses the dividend/split-ADJUSTED close, same reason as
 * breadth classification (yahoo.js): a raw close drops on ex-dividend days,
 * which would read as a fake weekly decline right at the average.
 */
export function weeklyCloses(bars) {
  const weeks = [];
  let currentKey = null;
  for (const b of bars) {
    const key = isoWeek(b.date);
    if (key !== currentKey) {
      weeks.push({ week: key, close: b.adjClose });
      currentKey = key;
    } else {
      weeks[weeks.length - 1].close = b.adjClose;
    }
  }
  return weeks;
}

/**
 * One ticker's reading as of the LAST bar in `bars`. Callers control "as of"
 * by how much of the bar array they pass in (see backfill-ma200w.js for a
 * historical read against a truncated array).
 *
 * Null when there isn't a full 200 weeks of history yet — a name listed under
 * ~3.8 years ago has no 200-week line to be near, the same honest omission
 * the Valuation page makes for companies its models can't value.
 */
export function ma200wSnapshot(bars) {
  if (!bars?.length) return null;
  const weeks = weeklyCloses(bars);
  if (weeks.length < MA_WEEKS) return null;

  const trailing = weeks.slice(-MA_WEEKS);
  const ma = trailing.reduce((sum, w) => sum + w.close, 0) / MA_WEEKS;
  const last = bars[bars.length - 1];
  const price = last.adjClose;
  if (!(ma > 0) || !(price > 0)) return null;

  return {
    asOf: last.date,
    price: Math.round(price * 100) / 100,
    ma200w: Math.round(ma * 100) / 100,
    pctFromMa: parseFloat((((price - ma) / ma) * 100).toFixed(1)),
  };
}

/**
 * Market-wide reading for one day, from that day's per-ticker snapshots.
 * `pctNear` (within `band`% either side of the line) is the headline number —
 * a support-testing analogue of pctAdvancing: it tells you how much of the
 * market is sitting AT its long-term trend right now, not which side of it.
 */
export function summarizeMa200w(rows, band = 5) {
  const universeCount = rows.length;
  if (universeCount === 0) return { universeCount: 0, pctNear: 0, pctBelow: 0 };
  const near = rows.filter(r => Math.abs(r.pctFromMa) <= band).length;
  const below = rows.filter(r => r.pctFromMa < 0).length;
  return {
    universeCount,
    pctNear: parseFloat((near / universeCount * 100).toFixed(2)),
    pctBelow: parseFloat((below / universeCount * 100).toFixed(2)),
  };
}
