// ──────────────────────────────────────────────
// Lambda Handler (supports REST API v1 & HTTP API v2)
// ──────────────────────────────────────────────

import { getAllTickers } from './lib/tickers.js';
import { fetchChart, fetchQuotes, computeSeries } from './scrapers/yahoo.js';
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

// Always re-scrape the full history and recompute the entire series fresh. This
// guarantees the whole breadth series is consistent with the current universe —
// no stale counts from prior runs. The universe is the FULL IDX list (~957
// stocks), so a run takes several minutes; ensure the Lambda timeout allows it
// (900s is configured). Counts are folded per-day incrementally (see below) to
// keep memory bounded for the large universe.
const DAYS_BACK = 2800; // ~7.5 years of trading days (history back to ~2019)

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

    // Fold each ticker's up/down/unchanged directly into per-day counts as we go,
    // instead of holding every ticker's full history in memory (≈957×1900 rows).
    const dayMap = {}; // date -> { date, advances, declines, unchanged }
    let successCount = 0;
    let failCount = 0;

    const BATCH_SIZE = 6;
    const BATCH_DELAY = 1500;

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(ticker => fetchQuotes(ticker, DAYS_BACK)));

      for (const quotes of results) {
        const MIN_DATA_POINTS = 10;
        if (quotes.length >= MIN_DATA_POINTS) {
          for (let k = 1; k < quotes.length; k++) {
            // Classify on ADJUSTED close so ex-dividend days are not miscounted
            // as declines (the root cause of the old A/D Line's downward drift).
            const prev = quotes[k - 1].adjClose;
            const curr = quotes[k].adjClose;
            const date = quotes[k].date;
            let day = dayMap[date];
            if (!day) day = dayMap[date] = { date, advances: 0, declines: 0, unchanged: 0 };
            if (curr > prev) day.advances++;
            else if (curr < prev) day.declines++;
            else day.unchanged++;
          }
          successCount++;
        } else {
          failCount++;
        }
      }

      if (i + BATCH_SIZE < tickers.length) {
        await sleep(BATCH_DELAY);
      }
    }

    if (successCount === 0) {
      return { success: false, message: 'No ticker data fetched', successCount: 0, failCount };
    }

    // Recompute the FULL series from the fresh scrape (drops phantom days).
    const series = computeSeries(Object.values(dayMap));

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
