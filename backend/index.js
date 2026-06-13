// ──────────────────────────────────────────────
// Lambda Handler (supports REST API v1 & HTTP API v2)
// ──────────────────────────────────────────────

import { getAllTickers } from './lib/tickers.js';
import { fetchChart, fetchQuotes, buildDailyCounts, computeSeries } from './scrapers/yahoo.js';
import { getAllData, batchPutData, deleteDates, acquireRefreshLock, releaseRefreshLock } from './lib/db.js';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  // API responses are dynamic — never let CloudFront/CDNs cache them.
  'Cache-Control': 'no-store',
};

function response(status, body) {
  return { statusCode: status, headers: HEADERS, body: JSON.stringify(body) };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getMethod(event) {
  return event.requestContext?.http?.method || event.httpMethod || '';
}

function getPath(event) {
  let p = event.rawPath || event.path || '';
  p = p.replace(/^\/[^/]+(\/api)/, '$1');
  return p;
}

// Always re-scrape the full history and recompute the entire series fresh.
// This is cheap (~30s) because the breadth universe is a small, stable, liquid
// set (~44 LQ45-style stocks), and it guarantees the whole A/D series is always
// consistent with the current universe — no stale counts from prior runs.
const DAYS_BACK = 1100; // ~3+ years of trading days

async function refreshData() {
  const locked = await acquireRefreshLock();
  if (!locked) {
    return { success: false, message: 'Refresh already in progress', locked: true };
  }

  try {
    const tickers = await getAllTickers();
    console.log(`Scraping ${tickers.length} tickers, ${DAYS_BACK} days back`);

    // IHSG index (^JKSE) OHLC for the price panel.
    const indexBars = await fetchChart('^JKSE', DAYS_BACK);
    const indexMap = {};
    for (const b of indexBars) {
      indexMap[b.date] = { ihsgOpen: b.open, ihsgHigh: b.high, ihsgLow: b.low, ihsg: b.close };
    }
    console.log(`IHSG index bars: ${indexBars.length}`);

    const allAD = [];
    let successCount = 0;
    let failCount = 0;

    const BATCH_SIZE = 3;
    const BATCH_DELAY = 2000;

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(ticker => fetchQuotes(ticker, DAYS_BACK)));

      for (const quotes of results) {
        const MIN_DATA_POINTS = 10;
        if (quotes.length >= MIN_DATA_POINTS) {
          const ad = [];
          for (let k = 1; k < quotes.length; k++) {
            // Classify on ADJUSTED close so ex-dividend days are not miscounted
            // as declines (the root cause of the old A/D Line's downward drift).
            const prev = quotes[k - 1].adjClose;
            const curr = quotes[k].adjClose;
            ad.push({
              date: quotes[k].date,
              direction: curr > prev ? 'advance' : curr < prev ? 'decline' : 'unchanged',
            });
          }
          allAD.push(ad);
          successCount++;
        } else {
          failCount++;
        }
      }

      if (i + BATCH_SIZE < tickers.length) {
        await sleep(BATCH_DELAY);
      }
    }

    if (allAD.length === 0) {
      return { success: false, message: 'No ticker data fetched', successCount: 0, failCount };
    }

    // Recompute the FULL series from the fresh scrape (drops phantom days).
    const freshCounts = buildDailyCounts(allAD);
    const series = computeSeries(Object.values(freshCounts));

    // Attach IHSG index OHLC per date.
    for (const row of series) {
      const idx = indexMap[row.date] || {};
      row.ihsg = idx.ihsg ?? null;
      row.ihsgOpen = idx.ihsgOpen ?? null;
      row.ihsgHigh = idx.ihsgHigh ?? null;
      row.ihsgLow = idx.ihsgLow ?? null;
    }

    // Overwrite the series and delete any dates no longer present.
    const existing = await getAllData();
    const seriesDates = new Set(series.map(d => d.date));
    const staleDates = existing.map(d => d.date).filter(date => !seriesDates.has(date));

    await batchPutData(series);
    if (staleDates.length > 0) {
      console.log(`Deleting ${staleDates.length} stale day(s): ${staleDates.join(', ')}`);
      await deleteDates(staleDates);
    }

    console.log(`Refresh complete: ${successCount} OK, ${failCount} failed, ${series.length} days stored`);

    return {
      success: true,
      message: 'Refreshed A/D data',
      tickersFetched: successCount,
      tickersFailed: failCount,
      daysStored: series.length,
      daysDropped: staleDates.length,
      latestDate: series[series.length - 1]?.date,
    };
  } finally {
    await releaseRefreshLock();
  }
}

export const handler = async (event) => {
  try {
    if (event.source === 'aws.events') {
      console.log('Scheduled refresh triggered');
      const result = await refreshData();
      return { statusCode: 200, body: JSON.stringify(result) };
    }

    const method = getMethod(event);
    const path = getPath(event);

    if (method === 'OPTIONS') {
      return response(200, {});
    }

    if (method === 'GET' && (path === '/api/ad' || path === '/api/ad/')) {
      const data = await getAllData();
      return response(200, { success: true, count: data.length, data });
    }

    if (method === 'POST' && (path === '/api/ad/refresh' || path === '/api/ad/refresh/')) {
      const result = await refreshData();
      return response(200, result);
    }

    return response(404, { error: `Not found: ${method} ${path}` });
  } catch (err) {
    console.error('Handler error:', err);
    return response(500, { error: err.message });
  }
};
