// ──────────────────────────────────────────────
// Lambda Handler (supports REST API v1 & HTTP API v2)
// ──────────────────────────────────────────────

import { getAllTickers } from './lib/tickers.js';
import { fetchQuotes, buildDailyCounts, computeSeries } from './scrapers/yahoo.js';
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

async function refreshData() {
  // Acquire lock to prevent concurrent refreshes
  const locked = await acquireRefreshLock();
  if (!locked) {
    return { success: false, message: 'Refresh already in progress', locked: true };
  }

  try {
    const tickers = await getAllTickers();

    // Existing per-day raw counts are the source of truth for history.
    // We merge today's scrape into them and recompute the FULL cumulative
    // series from the start, so the A/D Line can never drift/reset.
    const existing = await getAllData();
    const DAYS_BACK = existing.length > 365 ? 120 : 1100; // seed 3+ yrs once, then recent
    console.log(`Scraping ${tickers.length} tickers, ${DAYS_BACK} days back (existing ${existing.length} days)`);

    const allAD = [];
    let successCount = 0;
    let failCount = 0;

    const BATCH_SIZE = 3;
    const BATCH_DELAY = 2000;

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(ticker => fetchQuotes(ticker, DAYS_BACK))
      );

      for (const quotes of results) {
        const MIN_DATA_POINTS = 10;
        if (quotes.length >= MIN_DATA_POINTS) {
          const ad = [];
          for (let k = 1; k < quotes.length; k++) {
            const prev = quotes[k - 1].close;
            const curr = quotes[k].close;
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

      const progress = Math.min(i + BATCH_SIZE, tickers.length);
      if (progress % 50 === 0 || progress === tickers.length) {
        console.log(`Progress: ${progress}/${tickers.length} (${successCount} OK, ${failCount} fail)`);
      }

      // Delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < tickers.length) {
        await sleep(BATCH_DELAY);
      }
    }

    if (allAD.length === 0) {
      return { success: false, message: 'No ticker data fetched', successCount: 0, failCount };
    }

    // Merge fresh daily counts into existing history (fresh overwrites recent window)
    const freshCounts = buildDailyCounts(allAD);
    const merged = {};
    for (const d of existing) {
      merged[d.date] = { date: d.date, advances: d.advances, declines: d.declines, unchanged: d.unchanged };
    }
    for (const [date, counts] of Object.entries(freshCounts)) {
      merged[date] = counts;
    }

    // Recompute the full consistent series (drops phantom days, fixes cumulative chain)
    const series = computeSeries(Object.values(merged));

    // Write the recomputed series and delete any stale dates no longer present
    const seriesDates = new Set(series.map(d => d.date));
    const staleDates = Object.keys(merged).filter(date => !seriesDates.has(date));

    await batchPutData(series);
    if (staleDates.length > 0) {
      console.log(`Deleting ${staleDates.length} stale/phantom day(s): ${staleDates.join(', ')}`);
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
