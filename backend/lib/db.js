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

export async function putSentiment({ date, score, label, summary, headlineCount }) {
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      date: { S: `${SENTIMENT_PREFIX}${date}` },
      day: { S: date },
      score: { N: String(score) },
      label: { S: label || '' },
      summary: { S: summary || '' },
      headlineCount: { N: String(headlineCount) },
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
