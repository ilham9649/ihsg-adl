// ──────────────────────────────────────────────
// Bandarmology — cache → readings → DynamoDB (runs on the openclaw server)
// ──────────────────────────────────────────────
// Reads what fetch_stockbit.py cached, computes every stock's series and
// summary with backend/scrapers/bandarmology.js (the same code the tests
// cover), and stores them with backend/lib/db.js (`_bandarmology`, `bm#CODE`).
//
//   node jobs/bandarmology/build.mjs              write to the table (AWS creds, TABLE_NAME)
//   node jobs/bandarmology/build.mjs --out f.json write a local file instead (no AWS)
//
// The --out file has the API's shape, so it can be served to the dev server
// (`/api/bandarmology` from its `summary`, one stock from `series[CODE]`).

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStock } from '../../backend/scrapers/bandarmology.js';

const CACHE = process.env.BANDARMOLOGY_CACHE || '/root/bandarmology-cache';
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : null;
const LISTED_GAP_DAYS = 10; // first traded day this far after the history start = a listing inside the window

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

const universe = readJson(join(CACHE, 'universe.json'), null);
const codes = universe?.codes || (existsSync(join(CACHE, 'bs')) ? readdirSync(join(CACHE, 'bs')) : []);
const rows = [], seriesByCode = {};
let asOf = '';

for (const code of codes) {
  const hist = readJson(join(CACHE, 'hist', `${code}.json`), null);
  const bsDir = join(CACHE, 'bs', code);
  if (!hist || !existsSync(bsDir)) continue;
  const days = Object.entries(hist)
    .filter(([, v]) => v.frequency > 0 && v.close > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, open: v.open, high: v.high, low: v.low, close: v.close, lots: v.volume, trades: v.frequency, value: v.value, netForeign: v.net_foreign || 0 }));
  if (days.length < 30) continue;
  const summaries = {};
  for (const f of readdirSync(bsDir)) {
    if (!f.endsWith('.json')) continue;
    const s = readJson(join(bsDir, f), null);
    if (!s) continue;
    const side = rowsIn => rowsIn.map(([broker, lots, trades]) => ({ broker, lots, trades }));
    summaries[f.slice(0, 10)] = { buy: side(s.buy), sell: side(s.sell) };
  }
  const actions = readJson(join(CACHE, 'actions', `${code}.json`), []).map(a => ({ date: a.date, ratio: a.ratio }));
  // A stock whose first trade comes well after the history starts was listed
  // inside it: its listing day must stay out of the LPM window.
  const histStart = Object.keys(hist).sort()[0];
  const listed = (Date.parse(days[0].date) - Date.parse(histStart)) / 864e5 > LISTED_GAP_DAYS;
  const built = buildStock({ code, days, summaries, actions, listed });
  if (!built) continue;
  rows.push(built.row);
  // Compact for storage: rounded, short keys the page maps back.
  seriesByCode[code] = built.series.map(s => [s.date, s.close, +s.lpm.toPrecision(7), +s.lpmChange.toPrecision(6), Math.round(s.flow), s.vr == null ? null : +s.vr.toFixed(3), s.intensity == null ? null : +s.intensity.toPrecision(4)]);
  if (built.row.date > asOf) asOf = built.row.date;
}

const round = (v, d) => v == null ? null : +v.toFixed(d);
const summary = rows
  .filter(r => r.date === asOf) // a stock that didn't trade on the latest session is stale, not news
  .map(r => ({ ...r, ret20: round(r.ret20, 4), lpm20z: round(r.lpm20z, 2), flow20z: round(r.flow20z, 2), vr: round(r.vr, 2), vrz: round(r.vrz, 2), intensityZ: round(r.intensityZ, 2) }));

console.log(`bandarmology: ${summary.length} of ${codes.length} stocks current as of ${asOf}`);
if (!summary.length) { console.error('nothing to write'); process.exit(1); }

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ summary: { success: true, asOf, attempted: codes.length, count: summary.length, data: summary }, series: seriesByCode }));
  console.log(`written ${OUT}`);
} else {
  const { putBandarmology } = await import('../../backend/lib/db.js');
  const current = Object.fromEntries(summary.map(r => [r.code, seriesByCode[r.code]]));
  await putBandarmology({ asOf, rows: summary, attempted: codes.length }, current);
  console.log(`stored ${summary.length} stocks in DynamoDB`);
}
