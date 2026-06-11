// ──────────────────────────────────────────────
// Yahoo Finance Scraper
// Fetches daily OHLC for a batch of tickers
// ──────────────────────────────────────────────

import yahooFinance from 'yahoo-finance2';

// Suppress yahoo-finance2 logging
yahooFinance.setGlobalConfig({ logger: { warn: () => {}, error: () => {}, info: () => {} } });

/**
 * Fetch historical quotes for a single ticker
 * Returns array of { date, open, high, low, close, volume }
 */
export async function fetchQuotes(ticker, daysBack = 60) {
  try {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - daysBack + 1);
    start.setHours(0, 0, 0, 0);

    const result = await yahooFinance.chart(ticker, {
      period1: start,
      period2: end,
      interval: '1d',
    });

    if (!result || !result.quotes || result.quotes.length === 0) return [];

    return result.quotes
      .filter(q => q.close != null && q.open != null && q.date)
      .map(q => ({
        date: q.date.split('T')[0],
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume || 0,
      }));
  } catch (err) {
    console.error(`Failed to fetch ${ticker}:`, err.message?.substring(0, 100));
    return [];
  }
}

/**
 * Fetch all IHSG constituent tickers via ^JKSE components
 */
export async function fetchConstituentTickers() {
  try {
    const result = await yahooFinance.quoteSummary('^JKSE', {
      modules: ['defaultKeyStatistics'],
    });
    // Yahoo doesn't reliably return components list, so we rely on our known list
    return null;
  } catch {
    return null;
  }
}

/**
 * Calculate A/D metrics from daily price data
 * @param {Array} quotes - sorted by date ascending
 * @returns {Array} daily A/D records
 */
export function calculateAD(quotes) {
  if (quotes.length < 2) return [];

  const results = [];
  for (let i = 1; i < quotes.length; i++) {
    const prev = quotes[i - 1].close;
    const curr = quotes[i].close;

    if (curr > prev) results.push({ date: quotes[i].date, direction: 'advance' });
    else if (curr < prev) results.push({ date: quotes[i].date, direction: 'decline' });
    else results.push({ date: quotes[i].date, direction: 'unchanged' });
  }
  return results;
}

/**
 * Aggregate A/D across all tickers for each trading day
 */
export function aggregateAD(allTickersAD) {
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

  // Sort by date
  const days = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

  // Calculate derived metrics
  let cumulativeAD = 0;
  const ema19 = { value: 0, alpha: 2 / 20 };
  const ema39 = { value: 0, alpha: 2 / 40 };
  let emaInit = 0;

  return days.map(d => {
    const spread = d.advances - d.declines;
    cumulativeAD += spread;

    const ratio = d.declines === 0 ? (d.advances === 0 ? 1 : 100) : parseFloat((d.advances / d.declines).toFixed(4));

    // McClellan Oscillator: EMA(19) - EMA(39) of spread
    emaInit++;
    if (emaInit === 1) {
      ema19.value = spread;
      ema39.value = spread;
    } else {
      ema19.value = spread * ema19.alpha + ema19.value * (1 - ema19.alpha);
      ema39.value = spread * ema39.alpha + ema39.value * (1 - ema39.alpha);
    }
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
