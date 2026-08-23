// ──────────────────────────────────────────────
// News Scraper (CNBC Indonesia market RSS)
// ──────────────────────────────────────────────
// idx.co.id blocks server-side fetches (see tickers.js); this feed doesn't
// block a plain `curl` from a residential IP either — but it DID 403 the
// deployed Lambda (AWS datacenter IPs score worse with Cloudflare bot
// detection), so fetchHeadlines() spoofs a browser User-Agent, same as
// yahoo.js. It's CNBC Indonesia's general "Market" section, so it mixes
// genuine market-moving items with unrelated news (earthquakes, savings-account
// tips) — the sentiment prompt filters that at scoring time, not here.

const RSS_URL = 'https://www.cnbcindonesia.com/market/rss';

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

export async function fetchHeadlines() {
  const res = await fetch(RSS_URL, {
    // Verified working from a plain local curl (no UA) at dev time, but the
    // deployed Lambda got a 403 in prod — Cloudflare bot-scoring rates AWS
    // datacenter IPs worse than residential ones for identical headers.
    // Matches the User-Agent yahoo.js already spoofs for the same reason.
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15000),
  });
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
