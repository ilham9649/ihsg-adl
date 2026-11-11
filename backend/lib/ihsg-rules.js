// ──────────────────────────────────────────────
// IHSG methodology inputs we curate by hand (used by scrapers/movers.js)
// ──────────────────────────────────────────────
// Two things no free endpoint serves: which stocks IDX leaves out of the
// index, and free floats where the scraped snapshots (scrapers/freefloat.js) are
// wrong. Both are dated, because both change, and a past session must be
// weighted the way it actually was.

// ── HSC (High Shareholding Concentration) — stocks left out of the IHSG ──
// From 2026-11-02 IDX stops counting HSC stocks in the IHSG: they still list
// and trade, but their prices no longer move the index, and their ~18% of
// index weight goes to everyone else (divisor adjusted, so the level does not
// jump). Already the rule for IDX30/LQ45/IDX80.
//
// The list is NOT only quarterly any more. IDX planned quarterly reviews
// (effective the first trading day of Feb/May/Aug/Nov), but within two weeks
// of the first one it changed the list twice: MKNT was added after a 5 Nov
// evaluation, then the method changed and the list grew to 383 on 13 Nov.
// Check for announcements between reviews too. Each change REPLACES the list,
// so add a new dated entry rather than editing an old one: past sessions must
// keep the composition they actually had.
//
// 2026-11-02 — IDX announcement of 2026-10-22, as reported by IDXChannel (81
// codes, matching the count CNBC Indonesia and Bisnis attribute to IDX).
// Katadata's list omits TFCO; Liputan6's adds FILM and LUCY but skips a number
// in its own count — neither of those two is included here. The ~5 Nov step
// to 83 is left out: its exact effective date and second code aren't sourced,
// and the 13 Nov list covers it.
//
// 2026-11-13 — new method (Peng-00201/BEI.POP/10-2026): a stock is HSC when
// its top 10 shareholders hold ≥ 92.5%. The Rp5T universe floor and the
// price-impact test are gone. Ownership as of 2026-10-30, effective on the
// 2nd trading day after the 11 Nov announcement. 383 codes, a superset of the
// 81, about 6.16% of IHSG market cap (IDX's president director, 10 Nov).
// List as printed by CNBC Indonesia, 2026-11-11, numbered 1–383 with no gaps.

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
  {
    // 383 codes (the 81 above plus 302 more), from the 13 Nov 2026 list.
    from: '2026-11-13',
    tickers: [
      'ABDA', 'ACST', 'ADCP', 'ADES', 'ADMF', 'ADMG', 'AGAR', 'AGII', 'AGRS', 'AKPI',
      'AKSI', 'ALII', 'ALKA', 'ALMI', 'AMAG', 'AMAN', 'AMAR', 'AMFG', 'AMOR', 'ANJT',
      'APII', 'APLI', 'AREA', 'ARGO', 'ARTA', 'ASBI', 'ASDM', 'ASRM', 'AWAN', 'AXIO',
      'BABY', 'BAJA', 'BALI', 'BATA', 'BATR', 'BBHI', 'BBLD', 'BBMD', 'BBRM', 'BBSI',
      'BBSS', 'BCIC', 'BDKR', 'BDMN', 'BELI', 'BESS', 'BIKA', 'BIKE', 'BIMA', 'BINA',
      'BINO', 'BKDP', 'BKSW', 'BLES', 'BLOG', 'BLTZ', 'BLUE', 'BMAS', 'BNBA', 'BNGA',
      'BNII', 'BNLI', 'BOAT', 'BOBA', 'BOLT', 'BPFI', 'BPII', 'BPTR', 'BRAM', 'BREN',
      'BRIS', 'BRNA', 'BSSR', 'BSWD', 'BTON', 'BTPN', 'BUAH', 'BUDI', 'BUKK', 'BYAN',
      'CAKK', 'CAMP', 'CANI', 'CASH', 'CASS', 'CBPE', 'CBUT', 'CCSI', 'CDIA', 'CEKA',
      'CENT', 'CITA', 'CITY', 'CLAY', 'CLEO', 'CMNP', 'CMNT', 'CMPP', 'CNMA', 'CRAB',
      'CRSN', 'CSAP', 'CSRA', 'CTBN', 'DAAZ', 'DART', 'DAYA', 'DCII', 'DEPO', 'DGWG',
      'DLTA', 'DMND', 'DNAR', 'DNET', 'DSSA', 'DUTI', 'DVLA', 'DWGL', 'ECII', 'EDGE',
      'EKAD', 'ELPI', 'EMDE', 'ENAK', 'EPMT', 'ERTX', 'ESTA', 'ESTI', 'ETWA', 'FAPA',
      'FAST', 'FASW', 'FILM', 'FISH', 'FITT', 'FMII', 'FOOD', 'FORE', 'FORU', 'FPNI',
      'GDST', 'GDYR', 'GEMS', 'GGRP', 'GHON', 'GIAA', 'GLOB', 'GMFI', 'GMTD', 'GOLD',
      'GOLF', 'GRIA', 'GSMF', 'GTBO', 'GTRA', 'GUNA', 'GWSA', 'HALO', 'HATM', 'HDFA',
      'HERO', 'HITS', 'HMSP', 'HOMI', 'HOTL', 'HYGN', 'IBST', 'IDPR', 'IFII', 'IFSH',
      'IGAR', 'IKBI', 'IKPM', 'IMAS', 'IMJS', 'INAF', 'INDO', 'INDR', 'INDS', 'INPP',
      'INRU', 'INTD', 'IPAC', 'IPCM', 'IPOL', 'JARR', 'JAWA', 'JECC', 'JRPT', 'JSPT',
      'KAEF', 'KBLM', 'KDSI', 'KEJU', 'KIAS', 'KING', 'KINO', 'KLIN', 'KMTR', 'KOBX',
      'KOIN', 'KONI', 'KOPI', 'KSIX', 'LFLO', 'LIFE', 'LINK', 'LION', 'LMPI', 'LPCK',
      'LPGI', 'LRNA', 'MAPB', 'MAPI', 'MASB', 'MAYA', 'MBAP', 'MBSS', 'MCOL', 'MCOR',
      'MDIA', 'MDKI', 'MDLA', 'MEGA', 'MERK', 'META', 'MFMI', 'MGNA', 'MGRO', 'MINE',
      'MKAP', 'MKNT', 'MKPI', 'MKTR', 'MLBI', 'MLIA', 'MLPT', 'MMLP', 'MOLI', 'MORA',
      'MPRO', 'MPXL', 'MSJA', 'MSTI', 'MTEL', 'MTMH', 'MTSM', 'MTWI', 'MYOH', 'MYTX',
      'NCKL', 'NELY', 'NEST', 'NETV', 'NICE', 'NICK', 'NISP', 'NOBU', 'NZIA', 'OCAP',
      'OMED', 'OMRE', 'PALM', 'PANI', 'PANR', 'PBID', 'PBSA', 'PDES', 'PDPP', 'PEVE',
      'PGEO', 'PGUN', 'PJAA', 'PLIN', 'PMJS', 'PMUI', 'PNBS', 'PNGO', 'PNSE', 'POLI',
      'POLL', 'POLU', 'PORT', 'PRAY', 'PSAB', 'PSAT', 'PSDN', 'PSGO', 'PSSI', 'PTIS',
      'PTMR', 'PTPW', 'PTSN', 'RAAM', 'RANC', 'RDTX', 'RELI', 'RISE', 'RLCO', 'ROCK',
      'RODA', 'RONY', 'ROTI', 'RSCH', 'RSGK', 'SAFE', 'SAME', 'SAMF', 'SAPX', 'SATU',
      'SCCO', 'SCNP', 'SCPI', 'SDPC', 'SDRA', 'SGRO', 'SHID', 'SHIP', 'SILO', 'SIPD',
      'SKBM', 'SKLT', 'SKRN', 'SMAR', 'SMCB', 'SMDM', 'SMIL', 'SMKL', 'SMMT', 'SOHO',
      'SONA', 'SOSS', 'SOTS', 'SRAJ', 'SRTG', 'SSMS', 'SSTM', 'STAA', 'STTP', 'SUNI',
      'SUPA', 'SUPR', 'SURE', 'SWID', 'TALF', 'TAMU', 'TBIG', 'TBMS', 'TCID', 'TCPI',
      'TFCO', 'TGKA', 'TIFA', 'TIRA', 'TKIM', 'TLDN', 'TMAS', 'TOTO', 'TRGU', 'TRIO',
      'TRIS', 'TRJA', 'TRUS', 'TSPC', 'TYRE', 'UANG', 'UFOE', 'URBN', 'VAST', 'VERN',
      'VICI', 'VINS', 'VOKS', 'VRNA', 'WBSA', 'WICO', 'WIKA', 'WOMF', 'YPAS', 'YUPI',
      'ZBRA', 'ZONE', 'ZYRX',
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
// The snapshots come from one third-party source, and the daily
// estimate's miss shows where it is wrong: regressing each session's miss on
// each heavyweight's estimated points (2025-10 → 2026-10) singled out two
// names far outside noise — TPIA weighted ×2.2 too heavy (t = 13), BRMS ×3.2
// too light (t = −8.5). Both match published figures, entered here. Add a
// name only with a source; never tune a number to shrink the miss.
//
// Entries are dated like the HSC list: the latest `from` on or before the
// session applies; before the first, the float snapshots do. An override wins
// over every snapshot, so once the monthly snapshots get a code right, end its
// override with a `{ from, ratio: null }` step to hand it back to them.
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

/** The corrected free-float ratio for `ticker` on `date`, or null to use the float snapshots. */
export function floatOverrideOn(ticker, date, overrides = FLOAT_OVERRIDES) {
  let ratio = null;
  for (const entry of overrides[ticker] || []) if (entry.from <= date) ratio = entry.ratio;
  return ratio;
}
