// ──────────────────────────────────────────────
// IHSG A/D Data Library
// ──────────────────────────────────────────────

// Core IDX constituent tickers (frequently traded)
// We'll also get additional tickers from Yahoo Finance ^JKSE components
const KNOWN_TICKERS = [
  // LQ45 & big caps
  'BBCA','BBRI','BMRI','BBNI','TLKM','ASII','UNVR','HMSP','GOTO','TPIA',
  'BRPT','EMTK','BRIS','ICBP','MDKA','ANTM','BREN','BSDE','ERAA','BUKA',
  'BMTR','CTRA','AMRT','ACES','ADRO','AKRA','ARTO','BSSB','BTPS','CPIN',
  'DEPO','EXCL','GGRM','ICBP','INKP','INCO','INDF','INDS','INTD','ITMG',
  'JSMR','KLBF','LPPF','MAPI','MASS','MBAP','MEDC','MEGA','MFIN','MIKA',
  'MNCN','MPPA','PGAS','PGEO','PTBA','PTPP','PWON','SIDO','SMGR','TBIG',
  'TINS','TOWR','UNTR','WIKA','WSKT','WTON',
].map(t => t + '.JK');

export { KNOWN_TICKERS };
