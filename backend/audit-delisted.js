// ──────────────────────────────────────────────
// Audit the delisted universe against Yahoo.
// Run after adding codes to DELISTED_TICKERS in lib/tickers.js:
//   node backend/audit-delisted.js
//
// Checks each code for the three ways a delisted ticker goes wrong:
//   1. Yahoo never indexed it, or dropped it   -> no usable bars, remove the code
//   2. IDX reassigned the code to a new company -> a long dead stretch mid-series
//   3. The code is still listed today           -> already in IDX_TICKERS, duplicate
// ──────────────────────────────────────────────

import { IDX_TICKERS, DELISTED_TICKERS } from './lib/tickers.js';
import { fetchQuotes } from './scrapers/yahoo.js';

const DAYS_BACK = 6100;
const MIN_DATA_POINTS = 10; // matches the refresh loop's usability bar
const REUSE_GAP_DAYS = 200; // a halt this long is worth eyeballing for code reuse

const listed = new Set(IDX_TICKERS);

async function audit() {
  if (DELISTED_TICKERS.length === 0) {
    console.log('DELISTED_TICKERS is empty — nothing to audit.');
    return;
  }

  const rows = [];
  for (let i = 0; i < DELISTED_TICKERS.length; i += 5) {
    const batch = DELISTED_TICKERS.slice(i, i + 5);
    const results = await Promise.all(batch.map(t => fetchQuotes(t + '.JK', DAYS_BACK)));

    results.forEach((quotes, k) => {
      let maxGap = 0, gapAfter = '';
      for (let j = 1; j < quotes.length; j++) {
        const days = (new Date(quotes[j].date) - new Date(quotes[j - 1].date)) / 86400000;
        if (days > maxGap) { maxGap = days; gapAfter = quotes[j - 1].date; }
      }
      rows.push({
        ticker: batch[k],
        bars: quotes.length,
        first: quotes[0]?.date ?? '—',
        last: quotes[quotes.length - 1]?.date ?? '—',
        maxGap,
        gapAfter,
      });
    });

    if (i + 5 < DELISTED_TICKERS.length) await new Promise(r => setTimeout(r, 900));
  }

  console.log('code   bars   first        last         max_gap  after');
  for (const r of rows) {
    console.log(
      `${r.ticker.padEnd(6)} ${String(r.bars).padEnd(6)} ${r.first.padEnd(12)} ` +
      `${r.last.padEnd(12)} ${String(r.maxGap).padEnd(8)} ${r.gapAfter}`
    );
  }

  const unusable = rows.filter(r => r.bars < MIN_DATA_POINTS);
  const reused = rows.filter(r => r.maxGap > REUSE_GAP_DAYS);
  const stillListed = DELISTED_TICKERS.filter(t => listed.has(t));
  const dupes = DELISTED_TICKERS.filter((t, i) => DELISTED_TICKERS.indexOf(t) !== i);

  console.log(`\n${rows.length} codes, ${rows.length - unusable.length} usable`);
  const report = (label, items) =>
    console.log(`${label}: ${items.length ? items.join(', ') : 'none'}`);

  report('no usable Yahoo data (drop these)', unusable.map(r => r.ticker));
  report('also in IDX_TICKERS (duplicate)', stillListed);
  report('listed twice here', dupes);
  report(
    `halted >${REUSE_GAP_DAYS}d mid-series (check for code reuse)`,
    reused.map(r => `${r.ticker} ${r.maxGap}d after ${r.gapAfter}`)
  );

  const problems = unusable.length + stillListed.length + dupes.length;
  if (problems > 0) {
    console.log(`\n${problems} code(s) need fixing in DELISTED_TICKERS.`);
    process.exitCode = 1;
  }
}

audit().catch(err => {
  console.error('Audit failed:', err);
  process.exitCode = 1;
});
