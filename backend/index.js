// ──────────────────────────────────────────────
// Lambda Handler (supports REST API v1 & HTTP API v2)
// ──────────────────────────────────────────────

import { getAllTickers, IDX_TICKERS } from './lib/tickers.js';
import { fetchChart, fetchQuotes, computeSeries, isStaleComparison } from './scrapers/yahoo.js';
import { buildValuations, fetchShareCounts } from './scrapers/valuation.js';
import { fetchHeadlines, filterToday, wibDateString } from './scrapers/news.js';
import { scoreSentiment } from './scrapers/sentiment.js';
import { ma200wSnapshot, summarizeMa200w } from './scrapers/ma200w.js';
import { computeMovers, moversHistoryStart, BASELINE_FLOATS, aggregateMovers, parseRange, monthsSpanned, MOVERS_SESSIONS } from './scrapers/movers.js';
import { createTopLists } from './scrapers/toplists.js';
import { buildFloatSnapshot } from './scrapers/freefloat.js';
import { getAllData, batchPutData, deleteDates, putValuation, getValuation, putSentiment, getAllSentiment, putMa200wDaily, getAllMa200wDaily, putMa200wSnapshot, getMa200wSnapshot, putMovers, getMovers, putMoversMonths, getMoversDays, putFloatSnapshot, getFloatSnapshots, getSectors, putSectors, putTopMonths, getTopDay, getBandarmology, getBandarmologyStock, acquireRefreshLock, releaseRefreshLock, acquireValuationLock, releaseValuationLock, acquireSentimentCooldown, releaseSentimentCooldown } from './lib/db.js';

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

// Movers are stored for the last 252 sessions — at most 14 calendar months.
const MAX_RANGE_MONTHS = 14;

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
    // The movers estimate only needs the last year of closes, not 16 years.
    const moversFrom = moversHistoryStart(indexBars);

    // Fold each ticker's up/down/unchanged directly into per-day counts as we go,
    // instead of holding every ticker's full history in memory (≈957×1900 rows).
    const dayMap = {}; // date -> { date, advances, declines, unchanged }
    // 200-week MA distance rides along on the SAME fetch — DAYS_BACK already
    // covers far more than 200 weeks, so this costs zero extra Yahoo calls.
    const ma200wRows = [];
    // Index movers ride along too: the last year of closes plus each ticker's
    // share counts (one small extra Yahoo call per ticker, made in parallel
    // with its chart fetch). See scrapers/movers.js.
    const moverInputs = [];
    // Each session's gainers/losers/value/volume across the whole listing, for
    // the same trailing year as the movers, folded in as tickers arrive.
    const topFrom = indexBars[Math.max(0, indexBars.length - MOVERS_SESSIONS)]?.date;
    const tops = topFrom ? createTopLists(topFrom) : null;
    let successCount = 0;
    let failCount = 0;

    const BATCH_SIZE = 6;
    const BATCH_DELAY = 1500;

    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(ticker => Promise.all([
        fetchQuotes(ticker, DAYS_BACK),
        fetchShareCounts(ticker),
      ])));

      for (let j = 0; j < batch.length; j++) {
        const [quotes, shares] = results[j];
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

        // Not gated on MIN_DATA_POINTS: a week-old listing is already in the index.
        const recent = quotes.filter(q => q.date >= moversFrom);
        if (tops && recent.length > 1) tops.add(batch[j].replace(/\.JK$/, ''), recent);
        if (recent.length && shares.length) {
          moverInputs.push({
            ticker: batch[j].replace(/\.JK$/, ''),
            bars: recent.map(q => ({ date: q.date, close: q.close })),
            shares,
          });
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

    // Logged, not thrown: the movers lean on inputs breadth doesn't (share
    // counts, the free-float snapshots), and the breadth series above is
    // already written — a failure here must not report the whole refresh as failed.
    let moverDays = 0;
    try {
      const floatSnapshots = [BASELINE_FLOATS, ...await getFloatSnapshots()];
      // Sectors come from the valuation job; before its first run there are
      // none, and the sessions simply carry no sector totals.
      const sectors = await getSectors();
      const sectorOf = Object.keys(sectors).length ? sectors : null;
      const movers = computeMovers(indexBars, moverInputs, { floatSnapshots, sectorOf });
      if (movers.length > 0) {
        const floatAsOf = floatSnapshots.map(snap => snap.date).sort().pop();
        // Two shapes: each session's top five for the hover (`_movers`), and
        // every stock's points, a month per item, for date ranges.
        await putMovers(movers.map(({ m, ...day }) => day), floatAsOf);
        await putMoversMonths(movers.map(({ up, down, rest, ...day }) => day));
        moverDays = movers.length;
      }
    } catch (err) {
      console.error('Index movers failed:', err);
    }

    // Same rule: the top lists ride along, and a failure here is logged only.
    let topDays = 0;
    try {
      if (tops) {
        const byDate = tops.result();
        topDays = Object.keys(byDate).length;
        if (topDays) await putTopMonths(byDate);
      }
    } catch (err) {
      console.error('Top lists failed:', err);
    }

    console.log(`Refresh complete: ${successCount} OK, ${failCount} failed, ${series.length} days stored, ${ma200wRows.length} with a 200w MA, ${moverDays} days of movers from ${moverInputs.length} tickers, ${topDays} days of top lists`);

    return {
      success: true,
      message: 'Refreshed A/D data',
      tickersFetched: successCount,
      tickersFailed: failCount,
      daysStored: series.length,
      daysDropped: staleDates.length,
      latestDate: series[series.length - 1]?.date,
      ma200wTickers: ma200wRows.length,
      moverDays,
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

    const { rows, failed, sectors } = await buildValuations(tickers);
    // Saved before the valued-rows check: the sector map is useful even on a
    // night the valuations come back empty. Logged, never fatal.
    try {
      const known = await putSectors(sectors);
      console.log(`Sectors: ${Object.keys(sectors).length} this run, ${known} known`);
    } catch (err) {
      console.error('Sector map failed:', err);
    }
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

// Free floats change on corporate events (a sell-down, a placement), not with
// the tape, so this runs on its own monthly trigger — `job: "freefloat"` — and
// never inside the daily breadth scrape: ~960 pages takes ~6 minutes. Each run
// adds a dated snapshot; the movers estimate picks the one in force per session.
// No lock: two overlapping runs would write the same dated item twice.
async function refreshFreeFloat() {
  console.log(`Fetching free floats for ${IDX_TICKERS.length} codes`);
  const { floats, count, attempted, usable } = await buildFloatSnapshot(IDX_TICKERS);
  if (!usable) {
    console.error(`Free floats: only ${count} of ${attempted} codes answered — snapshot not stored`);
    return { success: false, message: `Only ${count} of ${attempted} codes returned a float — not stored`, floats: count, attempted };
  }

  const date = wibDateString();
  await putFloatSnapshot({ date, floats, attempted });
  console.log(`Free floats complete: ${date}, ${count} of ${attempted} codes`);
  return { success: true, message: 'Refreshed free floats', date, floats: count, attempted };
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
      if (event.job === 'freefloat') {
        console.log('Scheduled free-float refresh triggered');
        const result = await refreshFreeFloat();
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

    // ~6 minutes, so through API Gateway this returns 504 at 29s while the
    // Lambda finishes and stores the snapshot — the same as valuation.
    if (method === 'POST' && (path === '/api/freefloat/refresh' || path === '/api/freefloat/refresh/')) {
      if (!isRefreshAuthorized(event)) return response(401, { error: 'Unauthorized' });
      const result = await refreshFreeFloat();
      return response(200, result);
    }

    // A date range — or one date, from = to — summed over its sessions. The
    // dates are path segments, not a query string: CloudFront forwards no
    // query strings to the API (query_string = false), so ?from= never arrives.
    const range = method === 'GET' && path.match(/^\/api\/movers\/([^/]+)\/([^/]+)\/?$/);
    if (range) {
      const dates = parseRange(range[1], range[2]);
      if (!dates) return response(400, { error: 'Dates must be YYYY-MM-DD' });
      const months = monthsSpanned(dates.from, dates.to);
      // Only about a year is stored; a longer span can only cost reads.
      if (months.length > MAX_RANGE_MONTHS) return response(400, { error: `Ranges are limited to ${MAX_RANGE_MONTHS} months` });
      const result = aggregateMovers(await getMoversDays(months), dates.from, dates.to);
      // An empty range is an answer, not an error — same 200 + success:false as
      // the other routes use, so the page's console stays clean.
      if (!result) return response(200, { success: false, message: 'No sessions on record in that range' }, { cacheable: true });
      return response(200, { success: true, ...result }, { cacheable: true });
    }

    // One session for the front page's heatmap and top lists: every stock's
    // points, move, index weight and sector, plus the session's gainers,
    // losers, value and volume. A date in the path, never a query string
    // (see the range route above).
    const session = method === 'GET' && path.match(/^\/api\/session\/([^/]+)\/?$/);
    if (session) {
      const dates = parseRange(session[1], session[1]);
      if (!dates) return response(400, { error: 'Date must be YYYY-MM-DD' });
      const date = dates.from;
      const [days, top, sectors] = await Promise.all([getMoversDays([date.slice(0, 7)]), getTopDay(date), getSectors()]);
      const day = days.find(d => d.date === date);
      if (!day && !top) return response(200, { success: false, message: 'No session on record for that date' }, { cacheable: true });
      const stocks = day
        ? Object.entries(day.m || {}).map(([t, [pts, pct, bp]]) => [t, pts, pct, bp ?? null, sectors[t] || null])
        : [];
      return response(200, {
        success: true,
        date,
        close: day?.close ?? null, change: day?.change ?? null, pct: day?.pct ?? null, estimate: day?.estimate ?? null,
        stocks,  // [ticker, pts, pct, weightBp, sector]
        top,     // { gain, lose, value, volume }: [ticker, close, pct, value, volume]
      }, { cacheable: true });
    }

    // Bandarmology: written by the openclaw server job (jobs/bandarmology/), so
    // there is no refresh route here — the Lambda cannot reach Stockbit.
    if (method === 'GET' && (path === '/api/bandarmology' || path === '/api/bandarmology/')) {
      const { updatedAt, asOf, attempted, rows } = await getBandarmology();
      return response(200, { success: rows.length > 0, updatedAt, asOf, attempted, count: rows.length, data: rows }, { cacheable: true });
    }
    // One stock's series. The code is a path segment (CloudFront forwards no
    // query strings to the API, see the movers range route).
    const bandarStock = method === 'GET' && path.match(/^\/api\/bandarmology\/([A-Za-z]{4})\/?$/);
    if (bandarStock) {
      const code = bandarStock[1].toUpperCase();
      const stock = await getBandarmologyStock(code);
      if (!stock) return response(200, { success: false, message: `No bandarmology series for ${code}` }, { cacheable: true });
      return response(200, { success: true, code, updatedAt: stock.updatedAt, count: stock.series.length, data: stock.series }, { cacheable: true });
    }

    // Rides along with /api/ad/refresh like the 200-week page — no refresh route.
    if (method === 'GET' && (path === '/api/movers' || path === '/api/movers/')) {
      const { updatedAt, floatAsOf, rows } = await getMovers();
      return response(200, { success: true, updatedAt, floatAsOf, count: rows.length, data: rows }, { cacheable: true });
    }

    return response(404, { error: `Not found: ${method} ${path}` });
  } catch (err) {
    console.error('Handler error:', err);
    // Public route — never return raw internals (paths, env state, stack
    // fragments) to an unauthenticated caller. Full detail goes to CloudWatch.
    return response(500, { error: 'Internal server error' });
  }
};
