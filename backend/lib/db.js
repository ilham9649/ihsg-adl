// ──────────────────────────────────────────────
// DynamoDB Helper
// ──────────────────────────────────────────────

import { DynamoDBClient, ScanCommand, PutItemCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';

const client = new DynamoDBClient({});

const TABLE_NAME = process.env.TABLE_NAME || 'ihsg-adl';

export async function getAllData() {
  const result = await client.send(new ScanCommand({
    TableName: TABLE_NAME,
    ProjectionExpression: '#d, advances, declines, unchanged, spread, #r, adLine, mcClellan',
    ExpressionAttributeNames: { '#d': 'date', '#r': 'ratio' },
  }));

  return (result.Items || [])
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

export { TABLE_NAME };
