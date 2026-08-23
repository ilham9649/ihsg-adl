// ──────────────────────────────────────────────
// Lambda Handler (supports REST API v1 & HTTP API v2)
// ──────────────────────────────────────────────

import { getAllTickers } from './lib/tickers.js';
import { fetchChart, fetchQuotes, computeSeries, isStaleComparison } from './scrapers/yahoo.js';
import { buildValuations } from './scrapers/valuation.js';
import { fetchHeadlines, filterToday, wibDateString } from './scrapers/news.js';
import { scoreSentiment } from './scrapers/sentiment.js';
import { ma200wSnapshot, summarizeMa200w } from './scrapers/ma200w.js';
import { getAllData, batchPutData, deleteDates, putValuation, getValuation, putSentiment, getAllSentiment, putMa200wDaily, getAllMa200wDaily, putMa200wSnapshot, getMa200wSnapshot, acquireRefreshLock, releaseRefreshLock, acquireValuationLock, releaseValuationLock, acquireSentimentCooldown, releaseSentimentCooldown } from './lib/db.js';

const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

// GET endpoints return aggregate data that changes once a day, so they may be
// cached briefly by CloudFront and the browser. Mutations (refresh) stay
// uncached — they must never be served from a CDN edge.
function response(status, body, { cacheable = false } = {}) {
  return {
    statusCode: status,
    headers: {
      ...BASE_HEADERS,
      'Cache-Control': cacheable ? 'public, max-age=300' : 'no-store',
    },
    body: JSON.stringify(body),
  };
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

// The refresh POST routes are public (anyone who finds finance.sulaksono.id can
// hit them) but expensive: each re-scrapes Yahoo and burns Lambda/LLM cost.
// They are gated behind a shared secret (REFRESH_API_KEY, provisioned by
// Terraform). The EventBridge cron path bypasses this entirely — it invokes the
// Lambda directly under IAM, not through API Gateway.
function getHeader(event, name) {
  const headers = event.headers || {};
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

function isRefreshAuthorized(event) {
  const key = process.env.REFRESH_API_KEY;
  if (!key) return false; // not configured → deny (fail closed)
  return getHeader(event, 'x-api-key') === key;
}

// Always re-scrape the full history and recompute the entire series fresh. This
// guarantees the whole breadth series is consistent with the current universe —
// no stale counts from prior runs. The universe is the FULL IDX list (~957
// stocks), so a run takes several minutes; ensure the Lambda timeout allows it
// (900s is configured). Counts are folded per-day incrementally (see below) to
// keep memory bounded for the large universe.
const DAYS_BACK = 6100; // ~16.7 calendar years (history back to ~2010)

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
    // Reference "today" for the 200-week MA staleness check below — a
    // suspended/reassigned ticker's last bar can be long stale, and without a
    // real reference date that reads as sitting motionless AT its line
    // instead of what it is: a stock that hasn't traded in months.
    const latestIndexDate = indexBars[indexBars.length - 1]?.date;

    // Fold each ticker's up/down/unchanged directly into per-day counts as we go,
    // instead of holding every ticker's full history in memory (≈957×1900 rows).
    const dayMap = {}; // date -> { date, advances, declines, unchanged }
    // 200-week MA distance rides along on the SAME fetch — DAYS_BACK already
    // covers far more than 200 weeks, so this costs zero extra Yahoo calls.
    const ma200wRows = [];
    let successCount = 0;
    let failCount = 0;

    const BATCH_SIZE = 6;
    const BATCH_DELAY = 1500;

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(ticker => fetchQuotes(ticker, DAYS_BACK)));

      for (let j = 0; j < batch.length; j++) {
        const quotes = results[j];
        const MIN_DATA_POINTS = 10;
        if (quotes.length >= MIN_DATA_POINTS) {
          for (let k = 1; k < quotes.length; k++) {
            // Classify on ADJUSTED close so ex-dividend days are not miscounted
            // as declines (the root cause of the old A/D Line's downward drift).
            const prev = quotes[k - 1].adjClose;
            const curr = quotes[k].adjClose;
            const date = quotes[k].date;
            // Don't classify against a stale previous close (suspension resume,
            // or a ticker code IDX reassigned to a different company).
            if (isStaleComparison(quotes[k - 1].date, date)) continue;
            let day = dayMap[date];
            if (!day) day = dayMap[date] = { date, advances: 0, declines: 0, unchanged: 0 };
            if (curr > prev) day.advances++;
            else if (curr < prev) day.declines++;
            else day.unchanged++;
          }
          successCount++;

          const snap = ma200wSnapshot(quotes, latestIndexDate);
          if (snap) ma200wRows.push({ ticker: batch[j].replace(/\.JK$/, ''), ...snap });
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

    // Today's per-ticker table overwrites the single snapshot (like
    // Valuation); the market-wide reading joins the daily time series (like
    // Sentiment) so the trend gains one point per refresh, indefinitely.
    if (ma200wRows.length > 0) {
      ma200wRows.sort((a, b) => Math.abs(a.pctFromMa) - Math.abs(b.pctFromMa));
      await putMa200wSnapshot(ma200wRows);
      const latestDate = series[series.length - 1]?.date;
      if (latestDate) await putMa200wDaily({ date: latestDate, ...summarizeMa200w(ma200wRows) });
    }

    console.log(`Refresh complete: ${successCount} OK, ${failCount} failed, ${series.length} days stored, ${ma200wRows.length} with a 200w MA`);

    return {
      success: true,
      message: 'Refreshed A/D data',
      tickersFetched: successCount,
      tickersFailed: failCount,
      daysStored: series.length,
      daysDropped: staleDates.length,
      latestDate: series[series.length - 1]?.date,
      ma200wTickers: ma200wRows.length,
    };
  } finally {
    await releaseRefreshLock();
  }
}

// Valuations move only when a company files, so this runs on its own schedule —
// not with the daily breadth job. Each ticker costs three Yahoo calls, so the
// two jobs together would exceed the 900s Lambda timeout.
async function refreshValuations() {
  const locked = await acquireValuationLock();
  if (!locked) {
    return { success: false, message: 'Valuation refresh already in progress', locked: true };
  }

  try {
    const tickers = await getAllTickers();
    console.log(`Valuing ${tickers.length} tickers`);

    const { rows, failed } = await buildValuations(tickers);
    if (rows.length === 0) {
      return { success: false, message: 'No valuations computed', tickersFailed: failed };
    }

    await putValuation(rows, tickers.length);
    console.log(`Valuation complete: ${rows.length} valued, ${failed} without usable fundamentals`);

    return {
      success: true,
      message: 'Refreshed valuations',
      tickersValued: rows.length,
      tickersFailed: failed,
      cheapest: rows[0]?.ticker,
    };
  } finally {
    await releaseValuationLock();
  }
}

// Market-wide only (not per-ticker), and its own trigger like valuation. Unlike
// the free Yahoo-only jobs, each run is a billed LLM call behind a public POST
// route with no auth — acquireSentimentCooldown guards against that being spammed.
const MIN_TODAY_HEADLINES = 3;

async function refreshSentiment() {
  const cooled = await acquireSentimentCooldown();
  if (!cooled) {
    return { success: false, message: 'Sentiment was refreshed too recently — try again in a few minutes', locked: true };
  }

  const all = await fetchHeadlines();
  let headlines = filterToday(all);
  if (headlines.length < MIN_TODAY_HEADLINES) {
    // Thin news day (or the cron ran before much had published) — fall back to
    // the most recent headlines regardless of date rather than skip the day.
    headlines = all.slice().sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0)).slice(0, 20);
  }
  if (headlines.length === 0) {
    await releaseSentimentCooldown(); // no LLM call made, no cost incurred — safe to retry sooner
    return { success: false, message: 'No headlines fetched' };
  }

  const result = await scoreSentiment(headlines);
  if (!result) {
    return { success: false, message: 'LLM response unparseable', headlineCount: headlines.length };
  }

  const date = wibDateString();
  await putSentiment({ date, ...result, headlineCount: headlines.length });
  console.log(`Sentiment complete: ${date} score=${result.score} (${headlines.length} headlines)`);

  return {
    success: true,
    message: 'Refreshed sentiment',
    date,
    score: result.score,
    label: result.label,
    headlineCount: headlines.length,
  };
}

export const handler = async (event) => {
  try {
    if (event.source === 'aws.events') {
      if (event.job === 'valuation') {
        console.log('Scheduled valuation triggered');
        const result = await refreshValuations();
        return { statusCode: 200, body: JSON.stringify(result) };
      }
      if (event.job === 'sentiment') {
        console.log('Scheduled sentiment triggered');
        const result = await refreshSentiment();
        return { statusCode: 200, body: JSON.stringify(result) };
      }
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
      return response(200, { success: true, count: data.length, data }, { cacheable: true });
    }

    if (method === 'POST' && (path === '/api/ad/refresh' || path === '/api/ad/refresh/')) {
      if (!isRefreshAuthorized(event)) return response(401, { error: 'Unauthorized' });
      const result = await refreshData();
      return response(200, result);
    }

    if (method === 'GET' && (path === '/api/valuation' || path === '/api/valuation/')) {
      const { updatedAt, attempted, rows } = await getValuation();
      return response(200, { success: true, count: rows.length, attempted, updatedAt, data: rows }, { cacheable: true });
    }

    if (method === 'POST' && (path === '/api/valuation/refresh' || path === '/api/valuation/refresh/')) {
      if (!isRefreshAuthorized(event)) return response(401, { error: 'Unauthorized' });
      const result = await refreshValuations();
      return response(200, result);
    }

    if (method === 'GET' && (path === '/api/sentiment' || path === '/api/sentiment/')) {
      const data = await getAllSentiment();
      return response(200, { success: true, count: data.length, data }, { cacheable: true });
    }

    if (method === 'POST' && (path === '/api/sentiment/refresh' || path === '/api/sentiment/refresh/')) {
      const result = await refreshSentiment();
      return response(200, result);
    }

    // No separate refresh route: this rides along with /api/ad/refresh (or the
    // daily breadth cron), so there is nothing new to trigger here.
    if (method === 'GET' && (path === '/api/ma200w' || path === '/api/ma200w/')) {
      const [trend, snapshot] = await Promise.all([getAllMa200wDaily(), getMa200wSnapshot()]);
      return response(200, {
        success: true,
        trend,
        updatedAt: snapshot.updatedAt,
        count: snapshot.rows.length,
        data: snapshot.rows,
      }, { cacheable: true });
    }

    return response(404, { error: `Not found: ${method} ${path}` });
  } catch (err) {
    console.error('Handler error:', err);
    return response(500, { error: err.message });
  }
};
