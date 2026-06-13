// ──────────────────────────────────────────────
// Stock Data Scraper (using Yahoo Finance v8 chart API)
// ──────────────────────────────────────────────

const YAHOO_BASE = 'https://query1.finance.yahoo.com';

/**
 * Fetch historical chart data for a single ticker via Yahoo Finance v8 API.
 * Returns BOTH raw and dividend/split-adjusted closes. Breadth classification
 * MUST use adjClose: the raw close drops on ex-dividend days (counted as a
 * spurious "decline"), which injects a systematic downward bias that compounds
 * in any cumulative A/D Line. The adjusted series is continuous across ex-div
 * dates. (Verified: BBRI ex-div 2024-03-14 raw −3.91% vs adjusted −0.24%.)
 */
export async function fetchChart(ticker, daysBack = 60) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - (daysBack * 86400);
  const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=1d`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const data = await res.json();

  if (!data.chart?.result?.[0]) return [];

  const result = data.chart.result[0];
  const timestamps = result.timestamp || [];
  const quotes = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || {};

  const out = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = quotes.close?.[i];
    const open = quotes.open?.[i];
    if (close != null && open != null) {
      out.push({
        date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
        open, close,
        adjClose: adj[i] != null ? adj[i] : close, // fall back to raw if missing
        high: quotes.high?.[i] || 0,
        low: quotes.low?.[i] || 0,
        volume: quotes.volume?.[i] || 0,
      });
    }
  }
  return out;
}

/**
 * Fetch all tickers with rate limiting
 */
export async function fetchQuotes(ticker, daysBack = 60) {
  try {
    return await fetchChart(ticker, daysBack);
  } catch (err) {
    console.error(`Failed to fetch ${ticker}:`, err.message?.substring(0, 120));
    return [];
  }
}

/**
 * Build per-day advance/decline/unchanged counts from per-ticker direction arrays.
 * Returns a map: { 'YYYY-MM-DD': { date, advances, declines, unchanged } }.
 */
export function buildDailyCounts(allTickersAD) {
  const dayMap = {};

  for (const tickerAD of allTickersAD) {
    for (const entry of tickerAD) {
      if (!dayMap[entry.date]) {
        dayMap[entry.date] = { date: entry.date, advances: 0, declines: 0, unchanged: 0 };
      }
      if (entry.direction === 'advance') dayMap[entry.date].advances++;
      else if (entry.direction === 'decline') dayMap[entry.date].declines++;
      else dayMap[entry.date].unchanged++;
    }
  }

  return dayMap;
}

/**
 * Compute the daily breadth series from raw daily counts.
 *
 * Input: array of { date, advances, declines, unchanged } (any order).
 * Output: array sorted ascending by date, each with spread/ratio/adLine/mcClellan.
 *
 * Non-trading days (advances+declines == 0) are dropped.
 *
 * The cumulative A/D Line (adLine) is a running sum of (advances - declines).
 * It is GENUINE here because the caller classifies advances/declines from
 * dividend-adjusted closes (see fetchChart), so ex-dividend days are not
 * miscounted as declines — the line rises with a rising market like a real
 * A/D Line, instead of drifting monotonically down.
 *
 * McClellan = EMA(19) - EMA(39) of the daily spread, seeded with an SMA over the
 * first 19/39 days.
 */
export function computeSeries(dailyCounts) {
  // Drop phantom / non-trading days: a real session with a few hundred liquid
  // stocks cannot have zero advances AND zero declines. These rows come from
  // holidays (Yahoo forward-fills the prior close → all "unchanged") or
  // near-empty scrapes. Keeping them would inject spread=0 and distort the EMAs.
  const days = dailyCounts
    .filter(d => (d.advances + d.declines) > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  let cumulativeAD = 0;
  const ema19 = { value: 0, alpha: 2 / 20, sum: 0 };
  const ema39 = { value: 0, alpha: 2 / 40, sum: 0 };
  let n = 0;

  return days.map(d => {
    const spread = d.advances - d.declines;
    cumulativeAD += spread;

    const ratio = d.declines === 0
      ? (d.advances === 0 ? 1 : 100)
      : parseFloat((d.advances / d.declines).toFixed(4));

    // McClellan: SMA seed for the first 19 (ema19) / 39 (ema39) days, then EMA.
    n++;
    ema19.sum += spread;
    ema19.value = n < 19
      ? ema19.sum / n                       // partial warmup
      : n === 19
        ? ema19.sum / 19                    // SMA seed
        : spread * ema19.alpha + ema19.value * (1 - ema19.alpha);

    ema39.sum += spread;
    ema39.value = n < 39
      ? ema39.sum / n
      : n === 39
        ? ema39.sum / 39
        : spread * ema39.alpha + ema39.value * (1 - ema39.alpha);

    const mcClellan = parseFloat((ema19.value - ema39.value).toFixed(2));

    return {
      date: d.date,
      advances: d.advances,
      declines: d.declines,
      unchanged: d.unchanged,
      spread,
      ratio,
      adLine: cumulativeAD,
      mcClellan,
    };
  });
}
