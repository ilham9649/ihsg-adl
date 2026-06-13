// ──────────────────────────────────────────────
// DynamoDB Helper
// ──────────────────────────────────────────────
// Table: ihsg-adl (or TABLE_NAME env var)
// Partition Key: date (S) - required for idempotent writes
// ──────────────────────────────────────────────

import { DynamoDBClient, ScanCommand, PutItemCommand, BatchWriteItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';

const client = new DynamoDBClient({});

const TABLE_NAME = process.env.TABLE_NAME || 'ihsg-adl';

export async function getAllData() {
  const items = [];
  let lastEvaluatedKey = undefined;

  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_NAME,
      ProjectionExpression: '#d, advances, declines, unchanged, spread, #r, adLine, mcClellan',
      ExpressionAttributeNames: { '#d': 'date', '#r': 'ratio' },
      FilterExpression: '#d <> :lock',
      ExpressionAttributeValues: { ':lock': { S: LOCK_KEY } },
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items
    .map(item => ({
      date: item.date.S,
      advances: parseInt(item.advances.N, 10),
      declines: parseInt(item.declines.N, 10),
      unchanged: parseInt(item.unchanged.N, 10),
      spread: parseInt(item.spread.N, 10),
      ratio: parseFloat(item.ratio.N),
      adLine: parseInt(item.adLine.N, 10),
      mcClellan: parseFloat(item.mcClellan.N),
    }))
    .filter(item => !isNaN(item.advances)) // Filter out any malformed items
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function batchPutData(records) {
  // DynamoDB batch write max 25 items
  const chunks = [];
  for (let i = 0; i < records.length; i += 25) {
    chunks.push(records.slice(i, i + 25));
  }

  for (const chunk of chunks) {
    const putRequests = chunk.map(r => ({
      PutRequest: {
        Item: {
          date: { S: r.date },
          advances: { N: String(r.advances) },
          declines: { N: String(r.declines) },
          unchanged: { N: String(r.unchanged) },
          spread: { N: String(r.spread) },
          ratio: { N: String(r.ratio) },
          adLine: { N: String(r.adLine) },
          mcClellan: { N: String(r.mcClellan) },
        },
      },
    }));

    await client.send(new BatchWriteItemCommand({
      RequestItems: { [TABLE_NAME]: putRequests },
    }));
  }
}

export async function putData(record) {
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      date: { S: record.date },
      advances: { N: String(record.advances) },
      declines: { N: String(record.declines) },
      unchanged: { N: String(record.unchanged) },
      spread: { N: String(record.spread) },
      ratio: { N: String(record.ratio) },
      adLine: { N: String(record.adLine) },
      mcClellan: { N: String(record.mcClellan) },
    },
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
