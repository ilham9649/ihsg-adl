// ──────────────────────────────────────────────
// Ticker Discovery
// Fetches all IDX tickers from stockanalysis.com
// Falls back to built-in list if fetch fails
// ──────────────────────────────────────────────

// Core fallback list (LQ45 & liquid stocks)
const FALLBACK_TICKERS = [
  'BBCA','BBRI','BMRI','BBNI','TLKM','ASII','UNVR','HMSP','GOTO','TPIA',
  'BRPT','EMTK','BRIS','ICBP','MDKA','ANTM','BREN','BSDE','ERAA','BUKA',
  'BMTR','CTRA','AMRT','ACES','ADRO','AKRA','ARTO','BSSB','BTPS','CPIN',
  'DEPO','EXCL','GGRM','INKP','INCO','INDF','INDS','INTD','ITMG',
  'JSMR','KLBF','LPPF','MAPI','MASS','MBAP','MEDC','MEGA','MFIN','MIKA',
  'MNCN','MPPA','PGAS','PGEO','PTBA','PTPP','PWON','SIDO','SMGR','TBIG',
  'TINS','TOWR','UNTR','WIKA','WSKT','WTON',
];

/**
 * Discover all IDX tickers from stockanalysis.com
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
      const matches = html.matchAll(/href="\/quote\/idx\/([^/]+)\//g);
      for (const m of matches) {
        const ticker = m[1];
        if (ticker.length >= 3 && ticker.length <= 5 && /^[A-Z0-9]+$/.test(ticker)) {
          tickers.push(ticker);
        }
      }

      // Small delay between pages
      if (page < 3) await new Promise(r => setTimeout(r, 500));
    }

    const unique = [...new Set(tickers)];
    console.log(`Discovered ${unique.length} tickers from stockanalysis.com`);
    return unique.length > 100 ? unique : null; // Return null if too few (site might be blocked)
  } catch (err) {
    console.error('Ticker discovery failed:', err.message?.substring(0, 100));
    return null;
  }
}

/**
 * Get all tickers - discovered or fallback
 */
export async function getAllTickers() {
  const discovered = await discoverTickers();
  if (discovered) return discovered.map(t => t + '.JK');
  console.log(`Using fallback: ${FALLBACK_TICKERS.length} tickers`);
  return FALLBACK_TICKERS.map(t => t + '.JK');
}

export { FALLBACK_TICKERS };
