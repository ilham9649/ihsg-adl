// ──────────────────────────────────────────────
// Backfill the 200-week MA daily trend for the past year.
// ──────────────────────────────────────────────
// One-time script. Yahoo already serves each ticker's full daily history in a
// SINGLE call, so this fetches it once per ticker and then re-slices that same
// in-memory series at every trading day in the backfill window — no repeated
// Yahoo calls per ticker per day, unlike a naive "ask Yahoo for each date".
//
// Run locally against the PROD table (same pattern as other big
// repopulations — see CLAUDE.md "Testing Locally"):
//   AWS_REGION=ap-southeast-1 TABLE_NAME=ihsg-adl node backend/backfill-ma200w.js
// ──────────────────────────────────────────────

import { getAllTickers } from './lib/tickers.js';
import { fetchChart, fetchQuotes } from './scrapers/yahoo.js';
import { ma200wSnapshot, summarizeMa200w } from './scrapers/ma200w.js';
import { putMa200wDaily, putMa200wSnapshot } from './lib/db.js';

// 200 weeks (~3.85y) of MA lookback + the year being backfilled + slack for
// holidays/suspensions. Deliberately shorter than the daily refresh's
// DAYS_BACK=6100 — that job also needs 16 years for the breadth history, this
// one only needs enough to sit behind the MA window.
const DAYS_BACK = 2200;
const BACKFILL_DAYS = 365;
const BATCH_SIZE = 6;
const BATCH_DELAY = 1500;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function backfill() {
  const tickers = await getAllTickers();
  console.log(`Fetching ${DAYS_BACK}d of history for ${tickers.length} tickers...`);

  const barsByTicker = new Map();
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(t => fetchQuotes(t, DAYS_BACK)));
    batch.forEach((t, j) => barsByTicker.set(t, results[j]));
    if (i + BATCH_SIZE < tickers.length) await sleep(BATCH_DELAY);
    if ((i / BATCH_SIZE) % 20 === 0) console.log(`  fetched ${Math.min(i + BATCH_SIZE, tickers.length)}/${tickers.length}`);
  }

  // Trading-day calendar for the backfill window comes from the IHSG index's
  // own bars, not each ticker's — a suspended stock has no bar on a real
  // trading day, and that must not shrink the calendar.
  const indexBars = await fetchChart('^JKSE', BACKFILL_DAYS + 10);
  const backfillDates = indexBars.map(b => b.date).slice(-BACKFILL_DAYS);
  console.log(`Backfilling ${backfillDates.length} trading days...`);

  let lastRows = null;
  let written = 0;
  for (const date of backfillDates) {
    const rows = [];
    for (const [ticker, bars] of barsByTicker) {
      const upTo = bars.filter(b => b.date <= date);
      const snap = ma200wSnapshot(upTo, date);
      if (snap) rows.push({ ticker: ticker.replace(/\.JK$/, ''), ...snap });
    }
    if (rows.length === 0) continue; // too early for any ticker to have 200 weeks yet

    await putMa200wDaily({ date, ...summarizeMa200w(rows) });
    lastRows = rows;
    written++;
    if (written % 50 === 0) console.log(`  wrote ${written}/${backfillDates.length}`);
  }

  if (lastRows) {
    lastRows.sort((a, b) => Math.abs(a.pctFromMa) - Math.abs(b.pctFromMa));
    await putMa200wSnapshot(lastRows);
  }

  console.log(`Backfill complete: ${written} day(s) written.`);
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exitCode = 1;
});
