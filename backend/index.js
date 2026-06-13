// ──────────────────────────────────────────────
// Lambda Handler (supports REST API v1 & HTTP API v2)
// ──────────────────────────────────────────────

import { getAllTickers } from './lib/tickers.js';
import { fetchQuotes, aggregateAD } from './scrapers/yahoo.js';
import { getAllData, batchPutData, acquireRefreshLock, releaseRefreshLock } from './lib/db.js';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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
    // Discover tickers dynamically
    const tickers = await getAllTickers();
    console.log(`Scraping ${tickers.length} tickers...`);

    // Get existing data to find the last date (for incremental updates)
    const existingData = await getAllData();
    const lastDate = existingData.length > 0 ? existingData[existingData.length - 1].date : null;
    const lastADL = existingData.length > 0 ? existingData[existingData.length - 1].adLine : 0;
    console.log(`Existing data: ${existingData.length} days, last date: ${lastDate}, last ADL: ${lastADL}`);

    const allAD = [];
    let successCount = 0;
    let failCount = 0;

    // Process in parallel batches of 3 with 2s delay between batches
    const BATCH_SIZE = 3;
    const BATCH_DELAY = 2000;
    // Fetch enough data to ensure we have 3+ years on first run, or recent data for updates
    const DAYS_BACK = existingData.length > 365 ? 120 : 1100;

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(ticker => fetchQuotes(ticker, DAYS_BACK))
      );

      for (let j = 0; j < results.length; j++) {
        const quotes = results[j];
        const MIN_DATA_POINTS = 10;
        if (quotes.length >= MIN_DATA_POINTS) {
          const ad = [];
          for (let k = 1; k < quotes.length; k++) {
            const quoteDate = quotes[k].date;
            // Only include dates newer than the last date we have
            if (!lastDate || quoteDate > lastDate) {
              const prev = quotes[k - 1].close;
              const curr = quotes[k].close;
              ad.push({
                date: quoteDate,
                direction: curr > prev ? 'advance' : curr < prev ? 'decline' : 'unchanged',
              });
            }
          }
          if (ad.length > 0) {
            allAD.push(ad);
            successCount++;
          }
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

    if (allAD.length === 0 && existingData.length > 0) {
      return { success: true, message: 'No new data to add', tickersFetched: successCount, tickersFailed: failCount, daysStored: 0 };
    }

    if (allAD.length === 0) {
      return { success: false, message: 'No ticker data fetched', successCount: 0, failCount };
    }

    // Aggregate with continuation from last ADL value (for cumulative ADL)
    const aggregated = aggregateAD(allAD, {
      startingADL: lastADL,
      startingDate: lastDate,
    });
    await batchPutData(aggregated);

    console.log(`Refresh complete: ${successCount} OK, ${failCount} failed, ${aggregated.length} new days`);

    return {
      success: true,
      message: 'Refreshed A/D data',
      tickersFetched: successCount,
      tickersFailed: failCount,
      daysStored: aggregated.length,
      latestDate: aggregated[aggregated.length - 1]?.date,
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
