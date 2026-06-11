// ──────────────────────────────────────────────
// Lambda Handler
// ──────────────────────────────────────────────

import { KNOWN_TICKERS } from './lib/tickers.js';
import { fetchQuotes, aggregateAD } from './scrapers/yahoo.js';
import { getAllData, batchPutData, putData } from './lib/db.js';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function response(status, body) {
  return { statusCode: status, headers: HEADERS, body: JSON.stringify(body) };
}

/**
 * Scrape all tickers and compute A/D data, then store in DynamoDB
 */
async function refreshData() {
  const allAD = [];
  let successCount = 0;
  let failCount = 0;

  // Process in batches of 5 to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < KNOWN_TICKERS.length; i += batchSize) {
    const batch = KNOWN_TICKERS.slice(i, i + batchSize);
    const promises = batch.map(ticker => fetchQuotes(ticker, 90));
    const results = await Promise.all(promises);

    for (let j = 0; j < results.length; j++) {
      if (results[j].length > 0) {
        // Calculate per-ticker A/D
        const quotes = results[j];
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

    // Small delay between batches
    if (i + batchSize < KNOWN_TICKERS.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (allAD.length === 0) {
    return { success: false, message: 'No ticker data fetched', successCount: 0, failCount };
  }

  // Aggregate all tickers
  const aggregated = aggregateAD(allAD);

  // Store in DynamoDB
  await batchPutData(aggregated);

  console.log(`Refresh complete: ${successCount} tickers OK, ${failCount} failed, ${aggregated.length} days of data`);

  return {
    success: true,
    message: `Refreshed A/D data`,
    tickersFetched: successCount,
    tickersFailed: failCount,
    daysStored: aggregated.length,
    latestDate: aggregated[aggregated.length - 1]?.date,
  };
}

// ── API Routes ──
export const handler = async (event) => {
  try {
    const { httpMethod, path, body } = event;

    // CORS preflight
    if (httpMethod === 'OPTIONS') {
      return response(200, {});
    }

    // GET /api/ad — return all A/D data
    if (httpMethod === 'GET' && (path === '/api/ad' || path === '/api/ad/')) {
      const data = await getAllData();
      return response(200, {
        success: true,
        count: data.length,
        data,
      });
    }

    // POST /api/ad/refresh — trigger data refresh
    if (httpMethod === 'POST' && (path === '/api/ad/refresh' || path === '/api/ad/refresh/')) {
      const result = await refreshData();
      return response(200, result);
    }

    // Scheduled event (EventBridge cron)
    if (event.source === 'aws.events') {
      console.log('Scheduled refresh triggered');
      const result = await refreshData();
      return { statusCode: 200, body: JSON.stringify(result) };
    }

    return response(404, { error: 'Not found' });
  } catch (err) {
    console.error('Handler error:', err);
    return response(500, { error: err.message });
  }
};
