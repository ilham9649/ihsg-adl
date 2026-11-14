// ──────────────────────────────────────────────
// DynamoDB Helper
// ──────────────────────────────────────────────
// Table: ihsg-adl (or TABLE_NAME env var)
// Partition Key: date (S) - required for idempotent writes
// ──────────────────────────────────────────────

import { DynamoDBClient, ScanCommand, GetItemCommand, PutItemCommand, BatchWriteItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';

const client = new DynamoDBClient({});

const TABLE_NAME = process.env.TABLE_NAME || 'ihsg-adl';

export async function getAllData() {
  const items = [];
  let lastEvaluatedKey = undefined;

  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_NAME,
      ProjectionExpression: '#d, advances, declines, unchanged, spread, #r, adLine, mcClellan, pctAdvancing, ihsg, ihsgOpen, ihsgHigh, ihsgLow',
      ExpressionAttributeNames: { '#d': 'date', '#r': 'ratio' },
      // Only daily breadth rows. Skips the refresh lock and the valuation row,
      // neither of which carries the daily fields this parser reads.
      FilterExpression: 'attribute_exists(advances)',
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  const num = (item, key) => (item[key]?.N != null ? parseFloat(item[key].N) : null);

  return items
    .map(item => ({
      date: item.date.S,
      advances: parseInt(item.advances.N, 10),
      declines: parseInt(item.declines.N, 10),
      unchanged: parseInt(item.unchanged.N, 10),
      spread: parseInt(item.spread.N, 10),
      ratio: parseFloat(item.ratio.N),
      adLine: num(item, 'adLine'),
      mcClellan: parseFloat(item.mcClellan.N),
      pctAdvancing: num(item, 'pctAdvancing'),
      ihsg: num(item, 'ihsg'),
      ihsgOpen: num(item, 'ihsgOpen'),
      ihsgHigh: num(item, 'ihsgHigh'),
      ihsgLow: num(item, 'ihsgLow'),
    }))
    .filter(item => !isNaN(item.advances)) // Filter out any malformed items
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Build a DynamoDB Item from a daily record. Index OHLC fields are optional —
// only written when present (older rows / partial coverage).
function buildItem(r) {
  const item = {
    date: { S: r.date },
    advances: { N: String(r.advances) },
    declines: { N: String(r.declines) },
    unchanged: { N: String(r.unchanged) },
    spread: { N: String(r.spread) },
    ratio: { N: String(r.ratio) },
    adLine: { N: String(r.adLine) },
    mcClellan: { N: String(r.mcClellan) },
  };
  if (typeof r.pctAdvancing === 'number' && !isNaN(r.pctAdvancing)) {
    item.pctAdvancing = { N: String(r.pctAdvancing) };
  }
  for (const k of ['ihsg', 'ihsgOpen', 'ihsgHigh', 'ihsgLow']) {
    if (typeof r[k] === 'number' && !isNaN(r[k])) item[k] = { N: String(r[k]) };
  }
  return item;
}

export async function batchPutData(records) {
  // DynamoDB batch write max 25 items
  const chunks = [];
  for (let i = 0; i < records.length; i += 25) {
    chunks.push(records.slice(i, i + 25));
  }

  for (const chunk of chunks) {
    const putRequests = chunk.map(r => ({ PutRequest: { Item: buildItem(r) } }));

    await client.send(new BatchWriteItemCommand({
      RequestItems: { [TABLE_NAME]: putRequests },
    }));
  }
}

export async function putData(record) {
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: buildItem(record),
  }));
}

/**
 * Delete rows for the given dates (e.g. dropped phantom/holiday days).
 * Uses BatchWriteItem (DeleteRequest), max 25 per batch.
 */
export async function deleteDates(dates) {
  const list = dates.filter(Boolean);
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    const deleteRequests = chunk.map(date => ({
      DeleteRequest: { Key: { date: { S: date } } },
    }));
    await client.send(new BatchWriteItemCommand({
      RequestItems: { [TABLE_NAME]: deleteRequests },
    }));
  }
}

// ── Valuation ──
// The whole ranking lives in ONE item as a JSON string. It is read and written
// whole, never queried by ticker, so a row per ticker would only add scan cost.
// ponytail: ~500 tickers ≈ 120KB against DynamoDB's 400KB item limit. Split by
// sector, or move to S3, if the universe grows past roughly 1,500 names.
const VALUATION_KEY = '_valuation';

export async function putValuation(rows, attempted) {
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      date: { S: VALUATION_KEY },
      updatedAt: { S: new Date().toISOString() },
      // How many tickers were tried, so the page can report what fell out
      // rather than silently showing only the names that valued.
      attempted: { N: String(attempted) },
      rows: { S: JSON.stringify(rows) },
    },
  }));
}

export async function getValuation() {
  const result = await client.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { date: { S: VALUATION_KEY } },
  }));
  if (!result.Item?.rows?.S) return { updatedAt: null, attempted: 0, rows: [] };
  return {
    updatedAt: result.Item.updatedAt?.S || null,
    attempted: result.Item.attempted?.N ? parseInt(result.Item.attempted.N, 10) : 0,
    rows: JSON.parse(result.Item.rows.S),
  };
}

// ── Sentiment ──
// One item PER DAY, like the daily breadth rows, but under a distinct key
// prefix (`sent#YYYY-MM-DD`) so it can never collide with — or be clobbered
// by — the breadth refresh's full-item PutItem overwrite of the plain `date`
// key for that same calendar day.
const SENTIMENT_PREFIX = 'sent#';

export async function putSentiment({ date, score, label, summary, headlineCount, source = 'live' }) {
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      date: { S: `${SENTIMENT_PREFIX}${date}` },
      day: { S: date },
      score: { N: String(score) },
      label: { S: label || '' },
      summary: { S: summary || '' },
      headlineCount: { N: String(headlineCount) },
      // 'live' = same-day RSS headlines (the daily pipeline); 'backfill' =
      // retrospective search-engine results (see backfill-sentiment.js). Kept
      // distinct because the two aren't scored from equivalent input — a
      // backfilled day draws on whatever a search index still has, not the
      // full same-day news cycle.
      source: { S: source },
      updatedAt: { S: new Date().toISOString() },
    },
  }));
}

export async function getAllSentiment() {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(#d, :p)',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: { ':p': { S: SENTIMENT_PREFIX } },
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items
    .map(item => ({
      date: item.day.S,
      score: parseFloat(item.score.N),
      label: item.label?.S || '',
      summary: item.summary?.S || '',
      headlineCount: item.headlineCount?.N ? parseInt(item.headlineCount.N, 10) : null,
      source: item.source?.S || 'live',
      updatedAt: item.updatedAt?.S || null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── 200-Week MA ──
// Two different shapes for two different questions, mirroring the two
// patterns already established above:
//   - "how has the market read over time?" -> one small item PER DAY
//     (`ma200w#YYYY-MM-DD`, same prefix scheme as Sentiment), just a few
//     numbers each, scanned and kept forever — cheap even after years.
//   - "which stocks are near their line TODAY?" -> one single item
//     (`_ma200w_latest`, same pattern as Valuation's `_valuation`), holding
//     the full per-ticker table, overwritten on every refresh. There is no
//     reason to pay to store (and re-scan) a ~850-row table every day when
//     only the latest one is ever shown.
const MA200W_PREFIX = 'ma200w#';
const MA200W_SNAPSHOT_KEY = '_ma200w_latest';

export async function putMa200wDaily({ date, universeCount, pctNear, pctBelow }) {
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      date: { S: `${MA200W_PREFIX}${date}` },
      day: { S: date },
      universeCount: { N: String(universeCount) },
      pctNear: { N: String(pctNear) },
      pctBelow: { N: String(pctBelow) },
    },
  }));
}

export async function getAllMa200wDaily() {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(#d, :p)',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: { ':p': { S: MA200W_PREFIX } },
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items
    .map(item => ({
      date: item.day.S,
      universeCount: parseInt(item.universeCount.N, 10),
      pctNear: parseFloat(item.pctNear.N),
      pctBelow: parseFloat(item.pctBelow.N),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function putMa200wSnapshot(rows) {
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      date: { S: MA200W_SNAPSHOT_KEY },
      updatedAt: { S: new Date().toISOString() },
      rows: { S: JSON.stringify(rows) },
    },
  }));
}

export async function getMa200wSnapshot() {
  const result = await client.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { date: { S: MA200W_SNAPSHOT_KEY } },
  }));
  if (!result.Item?.rows?.S) return { updatedAt: null, rows: [] };
  return {
    updatedAt: result.Item.updatedAt?.S || null,
    rows: JSON.parse(result.Item.rows.S),
  };
}

// ── Index movers ──
// One item, like Valuation: the whole trailing year of per-session
// attributions (scrapers/movers.js) is recomputed on every breadth refresh and
// read whole. ~252 sessions × 10 movers ≈ 130KB against DynamoDB's 400KB item
// limit — a window much past two years needs one item per day instead.
const MOVERS_KEY = '_movers';

export async function putMovers(days, floatAsOf) {
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      date: { S: MOVERS_KEY },
      updatedAt: { S: new Date().toISOString() },
      // Which free-float table the weights came from, so the page can say so.
      floatAsOf: { S: floatAsOf || '' },
      rows: { S: JSON.stringify(days) },
    },
  }));
}

export async function getMovers() {
  const result = await client.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { date: { S: MOVERS_KEY } },
  }));
  if (!result.Item?.rows?.S) return { updatedAt: null, floatAsOf: null, rows: [] };
  return {
    updatedAt: result.Item.updatedAt?.S || null,
    floatAsOf: result.Item.floatAsOf?.S || null,
    rows: JSON.parse(result.Item.rows.S),
  };
}

// ── Index movers, every constituent per session (for date ranges) ──
// `_movers` above holds each session's top five, for the hover. A date range
// needs every stock's points on every session (~400 a day move the index by
// 0.01 pts or more), ~1MB a year — so it is stored a month per item
// (`movers#YYYY-MM`, ~100-200KB), overwritten with the window on every
// refresh. A range request reads only the months it spans.
const MOVERS_MONTH_PREFIX = 'movers#';

const monthBefore = month => {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

export async function putMoversMonths(days) {
  const byMonth = new Map();
  for (const d of days) {
    const month = d.date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(d);
  }
  const updatedAt = new Date().toISOString();
  for (const [month, rows] of byMonth) {
    await client.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        date: { S: `${MOVERS_MONTH_PREFIX}${month}` },
        updatedAt: { S: updatedAt },
        days: { S: JSON.stringify(rows) },
      },
    }));
  }
  // The window slides a session a day, so the month it just left is stale:
  // drop it (and the one before, in case a refresh was missed) rather than
  // let a range request read a month no longer recomputed.
  const first = [...byMonth.keys()].sort()[0];
  if (first) {
    const gone = monthBefore(first);
    await deleteDates([`${MOVERS_MONTH_PREFIX}${gone}`, `${MOVERS_MONTH_PREFIX}${monthBefore(gone)}`]);
  }
}

/** Every stored session in the given months (YYYY-MM), in no particular order. */
export async function getMoversDays(months) {
  const results = await Promise.all(months.map(month => client.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { date: { S: `${MOVERS_MONTH_PREFIX}${month}` } },
  }))));
  return results.flatMap(r => (r.Item?.days?.S ? JSON.parse(r.Item.days.S) : []));
}

// ── Sectors ──
// One item: { code: Yahoo sector } for the whole listing, written by the
// valuation job (which already asks Yahoo for every ticker's profile) and read
// by the breadth refresh, for the sector heatmap and the rotation map. Each
// run MERGES into the last, so a night where Yahoo's search answers for fewer
// codes cannot shrink the map.
const SECTORS_KEY = '_sectors';

export async function getSectors() {
  const result = await client.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { date: { S: SECTORS_KEY } },
  }));
  return result.Item?.sectors?.S ? JSON.parse(result.Item.sectors.S) : {};
}

export async function putSectors(fresh) {
  const merged = { ...await getSectors(), ...fresh };
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      date: { S: SECTORS_KEY },
      updatedAt: { S: new Date().toISOString() },
      sectors: { S: JSON.stringify(merged) },
    },
  }));
  return Object.keys(merged).length;
}

// ── Session top lists ──
// Each session's top gainers, losers, value and volume across the WHOLE
// listing (not just index weight), a month per item (`top#YYYY-MM`, ~40KB),
// rewritten for the trailing year on every breadth refresh — same shape and
// pruning as the movers months above.
const TOP_MONTH_PREFIX = 'top#';

export async function putTopMonths(byDate) {
  const byMonth = new Map();
  for (const [date, lists] of Object.entries(byDate)) {
    const month = date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, {});
    byMonth.get(month)[date] = lists;
  }
  const updatedAt = new Date().toISOString();
  for (const [month, days] of byMonth) {
    await client.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        date: { S: `${TOP_MONTH_PREFIX}${month}` },
        updatedAt: { S: updatedAt },
        days: { S: JSON.stringify(days) },
      },
    }));
  }
  const first = [...byMonth.keys()].sort()[0];
  if (first) {
    const gone = monthBefore(first);
    await deleteDates([`${TOP_MONTH_PREFIX}${gone}`, `${TOP_MONTH_PREFIX}${monthBefore(gone)}`]);
  }
}

/** One session's top lists, or null. */
export async function getTopDay(date) {
  const result = await client.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { date: { S: `${TOP_MONTH_PREFIX}${date.slice(0, 7)}` } },
  }));
  return result.Item?.days?.S ? (JSON.parse(result.Item.days.S)[date] || null) : null;
}

// ── Free-float snapshots ──
// One item PER RUN of the monthly freefloat job (`ff#YYYY-MM-DD`, same prefix
// scheme as Sentiment), each holding the whole listing's ratios as JSON
// (~12KB). Kept forever: together they are the dated float history the
// index-movers estimate weights past sessions by.
const FLOAT_PREFIX = 'ff#';

export async function putFloatSnapshot({ date, floats, attempted }) {
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      date: { S: `${FLOAT_PREFIX}${date}` },
      day: { S: date },
      attempted: { N: String(attempted) },
      floats: { S: JSON.stringify(floats) },
      updatedAt: { S: new Date().toISOString() },
    },
  }));
}

export async function getFloatSnapshots() {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(#d, :p)',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: { ':p': { S: FLOAT_PREFIX } },
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items
    .map(item => ({ date: item.day.S, floats: JSON.parse(item.floats.S) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Generic short-lived lock (TTL-gated conditional PutItem) ──
// Same primitive serves two different jobs: a mutex (block a second run while
// one is in flight) and a cooldown (block rapid repeats even sequentially).
async function acquireLock(key, ttlMs) {
  const now = Date.now();
  try {
    await client.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        date: { S: key },
        lockedAt: { N: String(now) },
        ttl: { N: String(now + ttlMs) },
      },
      ConditionExpression: 'attribute_not_exists(#d) OR #t < :cutoff',
      ExpressionAttributeNames: { '#d': 'date', '#t': 'lockedAt' },
      ExpressionAttributeValues: {
        ':cutoff': { N: String(now - ttlMs) },
      },
    }));
    return true;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return false; // Lock already held
    }
    throw err;
  }
}

async function releaseLock(key) {
  await client.send(new DeleteItemCommand({
    TableName: TABLE_NAME,
    Key: { date: { S: key } },
  }));
}

// ── Bandarmology ──
// Written by the job on the openclaw server (jobs/bandarmology/), never by the
// Lambda: the broker data comes from Stockbit, which needs a personal login.
// Two shapes, like Trend Line: one summary item (`_bandarmology`, the screener,
// ~100 rows ≈ 25KB) and one item per stock (`bm#CODE`, its chart series,
// ~130 sessions ≈ 15KB) so a stock page reads only its own history.
const BANDAR_KEY = '_bandarmology';
const BANDAR_PREFIX = 'bm#';

export async function putBandarmology({ asOf, rows, attempted }, seriesByCode) {
  const items = Object.entries(seriesByCode).map(([code, series]) => ({
    PutRequest: { Item: { date: { S: BANDAR_PREFIX + code }, updatedAt: { S: new Date().toISOString() }, series: { S: JSON.stringify(series) } } },
  }));
  for (let i = 0; i < items.length; i += 25) {
    let pending = { [TABLE_NAME]: items.slice(i, i + 25) };
    // BatchWriteItem may hand some writes back under load; retry those.
    for (let tries = 0; pending[TABLE_NAME]?.length && tries < 5; tries++) {
      const res = await client.send(new BatchWriteItemCommand({ RequestItems: pending }));
      pending = res.UnprocessedItems || {};
      if (pending[TABLE_NAME]?.length) await new Promise(r => setTimeout(r, 500 * 2 ** tries));
    }
    if (pending[TABLE_NAME]?.length) throw new Error(`bandarmology: ${pending[TABLE_NAME].length} stock items not written`);
  }
  // The summary last, so the page never lists a stock whose series isn't stored.
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      date: { S: BANDAR_KEY },
      updatedAt: { S: new Date().toISOString() },
      asOf: { S: asOf },
      attempted: { N: String(attempted) },
      rows: { S: JSON.stringify(rows) },
    },
  }));
}

export async function getBandarmology() {
  const result = await client.send(new GetItemCommand({ TableName: TABLE_NAME, Key: { date: { S: BANDAR_KEY } } }));
  if (!result.Item?.rows?.S) return { updatedAt: null, asOf: null, attempted: 0, rows: [] };
  return {
    updatedAt: result.Item.updatedAt?.S || null,
    asOf: result.Item.asOf?.S || null,
    attempted: result.Item.attempted?.N ? parseInt(result.Item.attempted.N, 10) : 0,
    rows: JSON.parse(result.Item.rows.S),
  };
}

export async function getBandarmologyStock(code) {
  const result = await client.send(new GetItemCommand({ TableName: TABLE_NAME, Key: { date: { S: BANDAR_PREFIX + code } } }));
  if (!result.Item?.series?.S) return null;
  return { updatedAt: result.Item.updatedAt?.S || null, series: JSON.parse(result.Item.series.S) };
}

// ── Refresh Lock — prevents two overlapping full-universe A/D scrapes ──
const LOCK_KEY = '_refresh_lock';
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function acquireRefreshLock() {
  return acquireLock(LOCK_KEY, LOCK_TTL_MS);
}

export async function releaseRefreshLock() {
  return releaseLock(LOCK_KEY);
}

// ── Valuation Lock — the valuation run is its own ~500s job (three Yahoo calls
// per ticker); block overlapping runs the same way as the breadth scrape ──
const VALUATION_LOCK_KEY = '_valuation_lock';
const VALUATION_LOCK_TTL_MS = 45 * 60 * 1000;

export async function acquireValuationLock() {
  return acquireLock(VALUATION_LOCK_KEY, VALUATION_LOCK_TTL_MS);
}

export async function releaseValuationLock() {
  return releaseLock(VALUATION_LOCK_KEY);
}

// ── Sentiment cooldown — each refresh is a billed LLM call behind a public,
// unauthenticated POST route. This blocks rapid repeats (accidental or
// deliberate) rather than leaving that route free to spam. 5 minutes is well
// under the once-a-day cadence the reading actually needs.
const SENTIMENT_LOCK_KEY = '_sentiment_lock';
const SENTIMENT_COOLDOWN_MS = 5 * 60 * 1000;

export async function acquireSentimentCooldown() {
  return acquireLock(SENTIMENT_LOCK_KEY, SENTIMENT_COOLDOWN_MS);
}

export async function releaseSentimentCooldown() {
  return releaseLock(SENTIMENT_LOCK_KEY);
}

export { TABLE_NAME };
