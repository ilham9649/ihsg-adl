// ──────────────────────────────────────────────
// Lambda Handler (supports REST API v1 & HTTP API v2)
// ──────────────────────────────────────────────

import { getAllTickers } from './lib/tickers.js';
import { fetchQuotes, aggregateAD } from './scrapers/yahoo.js';
import { getAllData, batchPutData } from './lib/db.js';

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
  // Discover tickers dynamically
  const tickers = await getAllTickers();
  console.log(`Scraping ${tickers.length} tickers...`);

  const allAD = [];
  let successCount = 0;
  let failCount = 0;

  // Process in parallel batches of 3 with 2s delay between batches
  const BATCH_SIZE = 3;
  const BATCH_DELAY = 2000;

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(ticker => fetchQuotes(ticker, 90))
    );

    for (let j = 0; j < results.length; j++) {
      const quotes = results[j];
      if (quotes.length > 1) {
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

  const aggregated = aggregateAD(allAD);
  await batchPutData(aggregated);

  console.log(`Refresh complete: ${successCount} OK, ${failCount} failed, ${aggregated.length} days`);

  return {
    success: true,
    message: 'Refreshed A/D data',
    tickersFetched: successCount,
    tickersFailed: failCount,
    daysStored: aggregated.length,
    latestDate: aggregated[aggregated.length - 1]?.date,
  };
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
