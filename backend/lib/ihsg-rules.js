// ──────────────────────────────────────────────
// IHSG methodology inputs we curate by hand (used by scrapers/movers.js)
// ──────────────────────────────────────────────
// Two things no free endpoint serves: which stocks IDX leaves out of the
// index, and free floats where the generated table (lib/freefloat.js) is
// wrong. Both are dated, because both change, and a past session must be
// weighted the way it actually was.

// ── HSC (High Shareholding Concentration) — stocks left out of the IHSG ──
// From 2026-11-02 IDX stops counting HSC stocks in the IHSG: they still list
// and trade, but their prices no longer move the index, and their ~18% of
// index weight goes to everyone else (divisor adjusted, so the level does not
// jump). Already the rule for IDX30/LQ45/IDX80.
//
// IDX reviews the list every quarter — evaluated in January, April, July and
// October, effective the first trading day of February, May, August and
// November. Each review REPLACES the list, so add a new dated entry rather
// than editing an old one: past sessions must keep the composition they
// actually had.
//
// Source: IDX announcement of 2026-10-22, as reported by IDXChannel (81 codes,
// matching the count CNBC Indonesia and Bisnis attribute to IDX). Katadata's
// list omits TFCO; Liputan6's adds FILM and LUCY but skips a number in its
// own count — neither of those two is included here.

export const HSC_SCHEDULE = [
  {
    from: '2026-11-02',
    tickers: [
      'ADES', 'AGAR', 'AGII', 'ALII', 'ALKA', 'BAJA', 'BALI', 'BBHI', 'BBMD', 'BBSI',
      'BDKR', 'BELI', 'BIKE', 'BINA', 'BKDP', 'BMAS', 'BNII', 'BNLI', 'BREN', 'BSWD',
      'BTPN', 'BYAN', 'CITA', 'CLAY', 'CMNP', 'CMNT', 'DCII', 'DGWG', 'DMND', 'DNET',
      'DSSA', 'DUTI', 'ELPI', 'EPMT', 'FAPA', 'FITT', 'GEMS', 'HATM', 'IFSH', 'INDO',
      'INPP', 'KING', 'KONI', 'LIFE', 'MAYA', 'MCOL', 'MDIA', 'MEGA', 'MGRO', 'MKPI',
      'MLPT', 'MORA', 'MPRO', 'MSJA', 'MTEL', 'NICK', 'PGUN', 'POLU', 'PRAY', 'PSAB',
      'RISE', 'RLCO', 'ROCK', 'SAFE', 'SAME', 'SATU', 'SHIP', 'SILO', 'SMAR', 'SMMT',
      'SOHO', 'SOTS', 'SRAJ', 'SSMS', 'STTP', 'TBIG', 'TCPI', 'TFCO', 'TMAS', 'WBSA',
      'YUPI',
    ],
  },
];

/** The HSC codes excluded from the IHSG on `date` (YYYY-MM-DD) — empty before the first review. */
export function hscExcludedOn(date, schedule = HSC_SCHEDULE) {
  let current = null;
  for (const entry of schedule) if (entry.from <= date) current = entry;
  return new Set(current ? current.tickers : []);
}

// ── Free-float corrections ──
// The generated table is one snapshot from one source, and the daily
// estimate's miss shows where it is wrong: regressing each session's miss on
// each heavyweight's estimated points (2025-10 → 2026-10) singled out two
// names far outside noise — TPIA weighted ×2.2 too heavy (t = 13), BRMS ×3.2
// too light (t = −8.5). Both match published figures, entered here. Add a
// name only with a source; never tune a number to shrink the miss.
//
// Entries are dated like the HSC list: the latest `from` on or before the
// session applies; before the first, the generated table does.
export const FLOAT_OVERRIDES = {
  // 10.9% until SCG Chemicals sold down on 2026-06-08, 25.7% after (company
  // disclosure, reported by CNBC Indonesia and Kontan). The table's 29% is the
  // post-sale float, so it overweighted TPIA ~2.7× for most of the window.
  TPIA: [
    { from: '2000-01-01', ratio: 0.109 },
    { from: '2026-06-08', ratio: 0.257 },
  ],
  // KSEI-based monthly free float: 45.3% (Apr 2026), 51.4% (Jun), 51.2% (Sep),
  // reported by Stockwatch and Kabarbursa — against the table's 17.5%.
  BRMS: [
    { from: '2000-01-01', ratio: 0.512 },
  ],
};

/** The corrected free-float ratio for `ticker` on `date`, or null to use the generated table. */
export function floatOverrideOn(ticker, date, overrides = FLOAT_OVERRIDES) {
  let ratio = null;
  for (const entry of overrides[ticker] || []) if (entry.from <= date) ratio = entry.ratio;
  return ratio;
}
