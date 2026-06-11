// ──────────────────────────────────────────────
// Lambda Handler (supports REST API v1 & HTTP API v2)
// ──────────────────────────────────────────────

import { KNOWN_TICKERS } from './lib/tickers.js';
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
  // REST API v1: path includes stage (e.g. /prod/api/ad)
  // HTTP API v2: rawPath (e.g. /api/ad)
  let p = event.rawPath || event.path || '';
  // Strip stage prefix if present
  p = p.replace(/^\/[^/]+(\/api)/, '$1');
  return p;
}

async function refreshData() {
  const allAD = [];
  let successCount = 0;
  let failCount = 0;

  for (const ticker of KNOWN_TICKERS) {
    const quotes = await fetchQuotes(ticker, 90);

    if (quotes.length > 1) {
      const ad = [];
      for (let i = 1; i < quotes.length; i++) {
        const prev = quotes[i - 1].close;
        const curr = quotes[i].close;
        ad.push({
          date: quotes[i].date,
          direction: curr > prev ? 'advance' : curr < prev ? 'decline' : 'unchanged',
        });
      }
      allAD.push(ad);
      successCount++;
    } else {
      failCount++;
    }

    await sleep(1200);
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
