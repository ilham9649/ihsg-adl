// ──────────────────────────────────────────────
// Breadth Universe — a STABLE, LIQUID set of large-cap IDX stocks (LQ45-style)
// ──────────────────────────────────────────────
// Using a stable, liquid universe — NOT the full ~900 IDX list — is essential for a
// trustworthy cumulative A/D Line. The broad list includes many illiquid / suspended
// small caps whose Yahoo data is forward-filled or stale, which injects phantom net
// declines that compound monotonically. With the raw ~500-stock universe the A/D Line
// declined ~16,000 over 3 years DURING a +28% IHSG rally — an artifact, not real
// breadth. A stable liquid universe (like the S&P 500's) produces a line that
// genuinely rises/falls with the market. Validated against the published
// S&P 500 / NYSE A/D Line methodology (raw vs adjusted close + universe stability).
//
// Advancers are classified on the dividend/split-ADJUSTED close (see yahoo.js).

const LIQUID_TICKERS = [
  // Banks & financials
  'BBCA','BBRI','BMRI','BBNI','BRIS','BTPS',
  // Consumer / staples / healthcare
  'UNVR','ICBP','INDF','GGRM','HMSP','KLBF','SIDO','AMRT','CPIN','ACES','MAPI','LPPF','JPFA',
  // Telco / media / towers
  'TLKM','ISAT','EXCL','EMTK','TBIG','TOWR',
  // Resources / energy / materials
  'ADRO','ANTM','PTBA','ITMG','INCO','MDKA','INKP','UNTR','ASII','TPIA','AKRA','PGAS','MEDC','MBAP',
  // Property / infrastructure
  'BSDE','CTRA','PWON','SMRA','JSMR',
];

/**
 * Breadth universe — always the stable liquid set (LQ45-style).
 */
export async function getAllTickers() {
  return LIQUID_TICKERS.map(t => t + '.JK');
}

// Kept for backward compatibility / tests.
const FALLBACK_TICKERS = LIQUID_TICKERS;
export { FALLBACK_TICKERS };
