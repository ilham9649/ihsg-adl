// ──────────────────────────────────────────────
// Stock Data Scraper (using Yahoo Finance v8 chart API)
// ──────────────────────────────────────────────

const YAHOO_BASE = 'https://query1.finance.yahoo.com';

/**
 * Fetch historical chart data for a single ticker via Yahoo Finance v8 API
 */
async function fetchChart(ticker, daysBack = 60) {
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

  const out = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = quotes.close?.[i];
    const open = quotes.open?.[i];
    if (close != null && open != null) {
      out.push({
        date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
        open, close,
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

  const days = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

  let cumulativeAD = 0;
  const ema19 = { value: 0, alpha: 2 / 20, sum: 0, count: 0 };
  const ema39 = { value: 0, alpha: 2 / 40, sum: 0, count: 0 };
  let emaInit = 0;

  return days.map(d => {
    const spread = d.advances - d.declines;
    cumulativeAD += spread;

    const ratio = d.declines === 0 ? (d.advances === 0 ? 1 : 100) : parseFloat((d.advances / d.declines).toFixed(4));

    emaInit++;
    if (emaInit < 20) {
      // Warmup period: use SMA
      ema19.sum += spread;
      ema19.count = emaInit;
      ema19.value = ema19.sum / ema19.count;
    } else {
      ema19.value = spread * ema19.alpha + ema19.value * (1 - ema19.alpha);
    }

    if (emaInit < 40) {
      ema39.sum += spread;
      ema39.count = emaInit;
      ema39.value = ema39.sum / ema39.count;
    } else {
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
