// ──────────────────────────────────────────────
// News Scraper (CNBC Indonesia market RSS)
// ──────────────────────────────────────────────
// idx.co.id blocks server-side fetches (see tickers.js); this feed does not —
// verified with a plain `curl`, no browser/User-Agent spoofing needed, 200 OK
// with real XML. It's CNBC Indonesia's general "Market" section, so it mixes
// genuine market-moving items with unrelated news (earthquakes, savings-account
// tips) — the sentiment prompt filters that at scoring time, not here.

const RSS_URL = 'https://www.cnbcindonesia.com/market/rss';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#039': "'" };
function decodeEntities(s) {
  return s.replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? m);
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return '';
  const raw = m[1].match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return decodeEntities((raw ? raw[1] : m[1]).trim());
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

export async function fetchHeadlines() {
  const res = await fetch(RSS_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseRssItems(await res.text());
}

// Indonesia runs a single WIB (UTC+7) timezone with no DST, so a fixed offset
// is all a "trading day" boundary needs — no timezone library required.
export function wibDateString(d = new Date()) {
  return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

export function filterToday(headlines, today = wibDateString()) {
  return headlines.filter(h => h.pubDate && wibDateString(h.pubDate) === today);
}
