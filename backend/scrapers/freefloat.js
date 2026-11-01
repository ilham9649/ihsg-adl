// ──────────────────────────────────────────────
// Free floats — the monthly snapshot job (stockanalysis.com)
// ──────────────────────────────────────────────
// IHSG is weighted by free-float market cap, so the index-movers estimate
// (movers.js) needs each company's free-float ratio. Yahoo's float sits behind
// quoteSummary (401) and IDX's own free-float report is behind Cloudflare, so
// this reads the "Float" and "Shares Outstanding" figures stockanalysis.com
// prints on each IDX statistics page — fetchable server-side, no auth.
//
// Their float definition (shares not held by insiders or large holders) is
// close to, not identical with, IDX's (scripless shares held by investors
// under 5%, excluding directors and treasury). Close enough to matter: over
// 2025-10 → 2026-10 these floats rebuilt the IHSG's daily point move with a
// 7-point mean miss, against 14 for full market cap. Where a figure is known
// to be wrong, a dated correction in lib/ihsg-rules.js overrides it.
//
// Runs as its own monthly job (index.js: refreshFreeFloat), never inside the
// daily breadth scrape — ~960 pages at a polite rate takes ~6 minutes. Each
// run is stored as a dated snapshot, so the floats build their own history.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BATCH_SIZE = 4;
const BATCH_DELAY = 1200;

// Below this share of codes answering, the run is treated as blocked or broken
// (a markup change, a datacenter IP turned away) and nothing is stored: a
// half-empty snapshot would hand most of the listing back to older figures
// without anyone noticing. The 2026-10-29 baseline answered for 90%.
export const MIN_COVERAGE = 0.6;

/**
 * One statistic from a stockanalysis page, which embeds them as
 * `{id:"float",title:"Float",value:"48.61B",hover:"48,610,141,397"}` —
 * `hover` carries the unabbreviated figure. Null when absent or "n/a".
 */
export function parseStat(html, id) {
  const m = html.match(new RegExp(`\\{id:"${id}",title:"[^"]*",value:"[^"]*",hover:"([^"]*)"`));
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Float shares / shares outstanding for one IDX code, or null. */
export async function fetchFloatRatio(code) {
  const res = await fetch(`https://stockanalysis.com/quote/idx/${encodeURIComponent(code)}/statistics/`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const float = parseStat(html, 'float');
  const out = parseStat(html, 'sharesout');
  return float && out ? float / out : null;
}

/**
 * Ratios for every code that has one, rounded to 0.1%, plus whether enough of
 * the listing answered to be worth storing.
 */
export async function buildFloatSnapshot(codes, { fetchRatio = fetchFloatRatio, delayMs = BATCH_DELAY } = {}) {
  const floats = {};
  for (let i = 0; i < codes.length; i += BATCH_SIZE) {
    const batch = codes.slice(i, i + BATCH_SIZE);
    const ratios = await Promise.all(batch.map(code => fetchRatio(code).catch(() => null)));
    batch.forEach((code, j) => {
      if (ratios[j] > 0) floats[code] = parseFloat(Math.min(1, ratios[j]).toFixed(3));
    });
    if (delayMs && i + BATCH_SIZE < codes.length) await new Promise(r => setTimeout(r, delayMs));
  }
  const count = Object.keys(floats).length;
  return {
    floats,
    count,
    attempted: codes.length,
    usable: codes.length > 0 && count / codes.length >= MIN_COVERAGE,
  };
}
