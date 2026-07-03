// ──────────────────────────────────────────────
// Breadth Universe — the FULL IDX list (~500 stocks) for genuine market breadth
// ──────────────────────────────────────────────
// A market-breadth A/D line is only meaningful over a BROAD universe. We discover
// the full Indonesia Stock Exchange list from stockanalysis.com (~500 tickers) so
// the breadth metrics reflect the whole market — not just a few mega-caps that
// prop up the cap-weighted IHSG.
//
// IMPORTANT: with the broad universe, equal-weight breadth over 2023–2026 is
// persistently NEGATIVE (hundreds of small/mid-caps bled while a handful of
// mega-caps held the index up), so the RAW cumulative A/D Line drifts down ~16k.
// That is genuine breadth, not a data artifact (a volume/forward-fill filter does
// not change it). The dashboard therefore leads with % Advancing — the share of
// the universe that rose each day, oscillating around 50% — instead of the raw
// A/D Line. Advancers are classified on the dividend/split-ADJUSTED close (see
// yahoo.js) so ex-dividend days are not miscounted as declines.

// Liquid LQ45-style fallback, used only if discovery fails (site blocked, etc.).
const FALLBACK_TICKERS = [
  'BBCA','BBRI','BMRI','BBNI','BRIS','BTPS',
  'UNVR','ICBP','INDF','GGRM','HMSP','KLBF','SIDO','AMRT','CPIN','ACES','MAPI','LPPF','JPFA',
  'TLKM','ISAT','EXCL','EMTK','TBIG','TOWR',
  'ADRO','ANTM','PTBA','ITMG','INCO','MDKA','INKP','UNTR','ASII','TPIA','AKRA','PGAS','MEDC','MBAP',
  'BSDE','CTRA','PWON','SMRA','JSMR',
];

/**
 * Discover the full IDX ticker list from stockanalysis.com.
 * Returns an array of bare symbols (no .JK), or null if discovery fails / is blocked.
 */
export async function discoverTickers() {
  try {
    const tickers = [];
    for (let page = 1; page <= 3; page++) {
      const url = page === 1
        ? 'https://stockanalysis.com/list/indonesia-stock-exchange/'
        : `https://stockanalysis.com/list/indonesia-stock-exchange/?p=${page}`;

      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) break;

      const html = await res.text();
      for (const m of html.matchAll(/href="\/quote\/idx\/([^/]+)\//g)) {
        const ticker = m[1];
        if (ticker.length >= 3 && ticker.length <= 5 && /^[A-Z0-9]+$/.test(ticker)) {
          tickers.push(ticker);
        }
      }
      if (page < 3) await new Promise(r => setTimeout(r, 500));
    }

    const unique = [...new Set(tickers)];
    console.log(`Discovered ${unique.length} IDX tickers from stockanalysis.com`);
    // Guard: if the site is blocked / layout changed we get too few — fall back.
    return unique.length > 100 ? unique : null;
  } catch (err) {
    console.error('Ticker discovery failed:', err.message?.substring(0, 100));
    return null;
  }
}

/**
 * Breadth universe — the discovered full IDX list, or the liquid fallback.
 */
export async function getAllTickers() {
  const discovered = await discoverTickers();
  const base = discovered || FALLBACK_TICKERS;
  if (!discovered) console.log(`Using fallback universe: ${FALLBACK_TICKERS.length} tickers`);
  return base.map(t => t + '.JK');
}

export { FALLBACK_TICKERS };
