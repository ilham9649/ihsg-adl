// ──────────────────────────────────────────────
// Backfill sentiment for the past ~3 months using Brave Search.
// ──────────────────────────────────────────────
// The live pipeline (news.js) only has a rolling RSS window — no history.
// Brave Search's index has real depth, but it's patchy: empirically, coverage
// is solid out to ~3 months back and falls off (non-monotonically, not a
// clean cutoff) beyond that — see CLAUDE.md. So this backfills 3 months, not
// a full year, and skips (not fakes) any day that comes up short — a gap in
// the chart is honest, a phantom score is not.
//
// One-time script, same pattern as backfill-ma200w.js. Run locally against
// the PROD table:
//   AWS_REGION=ap-southeast-1 TABLE_NAME=ihsg-adl BRAVE_API_KEY=... node backend/backfill-sentiment.js
// ──────────────────────────────────────────────

import { fetchChart } from './scrapers/yahoo.js';
import { mergeHeadlines } from './scrapers/news.js';
import { scoreSentiment } from './scrapers/sentiment.js';
import { putSentiment, getAllSentiment } from './lib/db.js';

const BACKFILL_CALENDAR_DAYS = 95; // ~3 months; trading days come out to ~63
const DOMAINS = ['cnbcindonesia.com', 'investasi.kontan.co.id', 'finance.detik.com'];
const MIN_HEADLINES = 3; // same bar as the live pipeline (MIN_TODAY_HEADLINES in index.js)
const BRAVE_DELAY_MS = 1100; // Brave free tier is ~1 req/sec

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Restricting to "IHSG" alone under-covers the day — real market moves get
// reported without ever naming the index (a dividend announcement, a foreign
// net-sell story, a rupiah move). Empirically, dropping the keyword entirely
// returns almost nothing (Brave needs *some* term to rank against under a
// site:+freshness filter) — an OR of the terms an Indonesian market piece
// actually uses gets close to the live RSS pipeline's "whole day's feed"
// coverage without pulling in the unrelated stories those feeds also carry.
const TOPIC_TERMS = '(IHSG OR saham OR bursa OR rupiah OR ekonomi)';

async function fetchBraveHeadlines(domain, date) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error('BRAVE_API_KEY not set');

  const q = encodeURIComponent(`site:${domain} ${TOPIC_TERMS}`);
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&freshness=${date}to${date}&count=20`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);

  const json = await res.json();
  const results = json.web?.results || [];
  return results
    .map(r => ({
      // The description carries most of the signal for a headline this
      // short — worth the extra tokens given how few results a backfilled
      // day typically has to score from.
      title: r.description ? `${r.title} — ${r.description}` : r.title,
      pubDate: r.page_age ? new Date(r.page_age) : new Date(date),
    }))
    .filter(h => h.title);
}

async function backfill() {
  const existing = await getAllSentiment();
  // Never overwrite a 'live' reading (real same-day news). A 'backfill' row is
  // fair game to re-run over — it's the lower-fidelity path by design, and a
  // re-run with a wider query or a better prompt should be able to upgrade it
  // rather than being permanently skipped because a row already exists.
  const liveDates = new Set(existing.filter(r => r.source === 'live').map(r => r.date));

  const indexBars = await fetchChart('^JKSE', BACKFILL_CALENDAR_DAYS);
  const dates = indexBars.map(b => b.date).filter(d => !liveDates.has(d));
  console.log(`${dates.length} trading day(s) to backfill (${indexBars.length - dates.length} already have a live reading).`);

  let written = 0;
  let skipped = 0;
  for (const date of dates) {
    const lists = [];
    for (const domain of DOMAINS) {
      try {
        lists.push(await fetchBraveHeadlines(domain, date));
      } catch (err) {
        console.error(`  ${date} ${domain}: ${err.message}`);
        lists.push([]);
      }
      await sleep(BRAVE_DELAY_MS);
    }

    const headlines = mergeHeadlines(lists);
    if (headlines.length < MIN_HEADLINES) {
      console.log(`  ${date}: skipped (only ${headlines.length} headline(s) found)`);
      skipped++;
      continue;
    }

    const result = await scoreSentiment(headlines);
    if (!result) {
      console.log(`  ${date}: skipped (LLM response unparseable)`);
      skipped++;
      continue;
    }

    await putSentiment({ date, ...result, headlineCount: headlines.length, source: 'backfill' });
    console.log(`  ${date}: score=${result.score} (${headlines.length} headlines)`);
    written++;
  }

  console.log(`Backfill complete: ${written} day(s) written, ${skipped} skipped.`);
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exitCode = 1;
});
