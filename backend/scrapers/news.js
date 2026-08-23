// ──────────────────────────────────────────────
// News Scraper (multiple Indonesian financial RSS feeds)
// ──────────────────────────────────────────────
// idx.co.id blocks server-side fetches (see tickers.js); these feeds don't
// block a plain `curl` from a residential IP either — but CNBC's DID 403 the
// deployed Lambda (AWS datacenter IPs score worse with Cloudflare bot
// detection), so fetchOneFeed() spoofs a browser User-Agent, same as yahoo.js.
//
// Three sources, not one — verified individually (plain curl, then confirmed
// CNBC's 403 in prod, see CLAUDE.md): CNBC's feed is general "Market" news
// (mixes genuine market items with unrelated stories, disasters/how-tos);
// Kontan's `investasi` feed is the most directly on-topic (ticker moves,
// IHSG levels, foreign net buy/sell); Detik Finance is general economy/finance.
// Multiple sources also means one outlet 403ing or going down for a day (as
// CNBC did) degrades the reading instead of silently killing it — each
// source fails independently in fetchHeadlines(), so partial coverage beats
// none. Bisnis.com and idx.co.id-style Cloudflare JS challenges (not just a
// UA check) can't be fetched server-side at all — skipped, not a bug.
//
// Backfill: investigated whether history could be pulled from the Wayback
// Machine's CDX index for these feed URLs. CNBC's feed has only ~11 snapshots
// over the past year (roughly monthly, not daily) — far too sparse for a
// meaningful "one point per trading day" series, so no backfill is done; the
// trend line starts thin from first deploy and grows one point per day.
const RSS_SOURCES = [
  'https://www.cnbcindonesia.com/market/rss',
  'https://investasi.kontan.co.id/rss',
  'https://finance.detik.com/rss',
];

// Named entities plus generic numeric refs (&#8217; / &#x2019;) — a regex parser
// that only handles a fixed named-entity table diverges from what a real XML
// parser decodes, which is exactly the kind of gap a crafted feed item can use
// to smuggle content past it undecoded.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return '';
  const raw = m[1].match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  // Collapse embedded newlines/control chars: titles feed straight into a
  // numbered list in the sentiment LLM prompt, and a raw newline there would
  // let one crafted headline masquerade as extra list entries.
  return decodeEntities((raw ? raw[1] : m[1])).replace(/\s+/g, ' ').trim();
}

function parseDate(raw) {
  const d = raw ? new Date(raw) : null;
  return d && !isNaN(d) ? d : null;
}

/** Pure parser (exported for tests) — title/link/pubDate out of an RSS <item> list. */
export function parseRssItems(xml) {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return blocks
    .map(b => ({
      title: extractTag(b, 'title'),
      link: extractTag(b, 'link'),
      pubDate: parseDate(extractTag(b, 'pubDate')),
    }))
    .filter(h => h.title);
}

async function fetchOneFeed(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseRssItems(await res.text());
}

/** Pure (exported for tests) — dedupe by exact title (case-insensitive; the
 * same story often runs on more than one outlet) and sort newest first, so a
 * downstream MAX_HEADLINES cap keeps the freshest items across all sources
 * rather than whichever source happened to be fetched/listed first. */
export function mergeHeadlines(lists) {
  const headlines = [];
  const seenTitles = new Set();
  for (const list of lists) {
    for (const h of list) {
      const key = h.title.toLowerCase();
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      headlines.push(h);
    }
  }
  return headlines.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));
}

export async function fetchHeadlines() {
  const results = await Promise.allSettled(RSS_SOURCES.map(fetchOneFeed));

  const lists = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Sentiment: news source failed, continuing without it (${RSS_SOURCES[i]}):`, r.reason?.message || r.reason);
      return;
    }
    lists.push(r.value);
  });
  if (lists.length === 0) throw new Error('All news sources failed');

  return mergeHeadlines(lists);
}

// Indonesia runs a single WIB (UTC+7) timezone with no DST, so a fixed offset
// is all a "trading day" boundary needs — no timezone library required.
export function wibDateString(d = new Date()) {
  return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

export function filterToday(headlines, today = wibDateString()) {
  return headlines.filter(h => h.pubDate && wibDateString(h.pubDate) === today);
}
