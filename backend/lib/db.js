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

// ── Refresh Lock ──
const LOCK_KEY = '_refresh_lock';
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function acquireRefreshLock() {
  const now = Date.now();
  try {
    await client.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        date: { S: LOCK_KEY },
        lockedAt: { N: String(now) },
        ttl: { N: String(now + LOCK_TTL_MS) },
      },
      ConditionExpression: 'attribute_not_exists(#d) OR #t < :now',
      ExpressionAttributeNames: { '#d': 'date', '#t': 'lockedAt' },
      ExpressionAttributeValues: {
        ':now': { N: String(now - LOCK_TTL_MS) },
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

export async function releaseRefreshLock() {
  await client.send(new DeleteItemCommand({
    TableName: TABLE_NAME,
    Key: { date: { S: LOCK_KEY } },
  }));
}

export { TABLE_NAME };
