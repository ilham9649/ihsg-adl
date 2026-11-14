// ──────────────────────────────────────────────
// LPM constants — one fixed scale per stock, measured, not derived
// ──────────────────────────────────────────────
// Bandar Metrics multiplies each stock's daily LPM change by a constant k that
// never changes over the stock's life and is in force from its first LPM day.
// It is not computable from any market data (tested against price, volume,
// trades, value, shares, IPO terms, first-day trading, sector, ticker): each
// value below was READ from Bandar Metrics' published LPM, as
//   k = actual change / (close x (buyAvg - sellAvg))
// and agrees to ~7 significant figures on three separate days (11-13 Nov 2026).
// A stock not listed here has no known k — measure it from one published day
// with `constantFromDay` in scrapers/lpm.js. k only scales the line: direction,
// divergence and crossovers are the same for any k (use 1 for signals).

export const LPM_CONSTANTS = {
  AADI: 0.7733675, AALI: 0.07059798, ABMM: 0.01527882, ACES: 4.206401, ADMR: 0.09090707, ADRO: 1.997694,
  AGII: 0.07452049, AKRA: 8.05239, AMMN: 25.62583, AMRT: 69.60373, ANTM: 79.1514, APLN: 0.1200969,
  ARCI: 2.834837, ARNA: 0.2861554, ARTO: 0.02098912, ASII: 0.9172438, ASRI: 0.3460067, ASSA: 0.01909696,
  AUTO: 0.7519931, AVIA: 3.948591, BACH: 4.075709, BBCA: 0.0228516, BBKP: 0.05054005, BBNI: 0.03334047,
  BBRI: 3.39119, BBTN: 46.16411, BBYB: 5.312775, BDMN: 0.7965438, BELI: 9.489893, BFIN: 62.153,
  BHIT: 45.70268, BIPI: 0.5754315, BIRD: 0.06331112, BJBR: 80.9688, BJTM: 1.104419, BMRI: 0.03139952,
  BMTR: 9.249383, BNGA: 0.06244205, BNLI: 0.04344139, BREN: 0.04729622, BRIS: 0.06290964, BRMS: 0.04681476,
  BRPT: 0.4005828, BSDE: 51.55943, BTPN: 64.72148, BTPS: 0.1555624, BUKA: 0.02829164, BULL: 0.04408664,
  BUMI: 0.02101754, BWPT: 0.8393039, BYAN: 28.40245, CBDK: 0.785314, CDIA: 74.85086, CLEO: 7.663217,
  CMRY: 7.92908, COIN: 1.396407, CPIN: 0.4271066, CTBN: 0.07041562, CTRA: 82.24904, CUAN: 0.05975468,
  DEWA: 4.323734, DKFT: 56.82865, DMAS: 0.01230574, DNET: 7.855077, DOID: 9.816165, DRMA: 0.5277712,
  DSNG: 0.06463099, DSSA: 0.0548668, ELSA: 72.8735, EMMI: 6.135677, EMTK: 51.72722, ENRG: 97.39871,
  ERAA: 0.4817233, ESSA: 55.50016, EXCL: 0.1199309, FILM: 0.669779, GEMS: 99.48364, GGRM: 0.4173001,
  GIAA: 0.8519245, GJTL: 0.2438112, GOOD: 3.118077, GOTO: 10.84505, HEAL: 1.803364, HEXA: 0.5839727,
  HMSP: 4.217918, HRTA: 0.2985622, HRUM: 0.8758201, ICBP: 1.409653, IMAS: 0.2098025, INCO: 0.2258291,
  INDF: 0.05378918, INDY: 67.57521, INET: 0.02829302, INKP: 60.27044, INTP: 9.949574, ISAT: 0.02992591,
  ISSP: 82.57818, ITMG: 3.128573, JARR: 0.08575288, JECX: 0.5675113, JELI: 3.117456, JPFA: 2.833505,
  JSMR: 0.2381009, KAEF: 79.8783, KIJA: 71.46829, KKGI: 0.8281905, KLBF: 0.5380452, KRAS: 67.2832,
  LINK: 0.04693738, LPCK: 0.2371087, LPKR: 1.977879, LPPF: 0.7614182, LSIP: 0.5059818, MAIN: 2.860833,
  MAPA: 0.4704555, MAPI: 0.03891675, MARK: 0.2750696, MBMA: 0.08397427, MDKA: 8.233095, MEDC: 0.06291823,
  MEGA: 62.78272, MIDI: 67.92622, MIKA: 2.585034, MLPL: 45.39375, MLPT: 7.162633, MNCN: 0.5440814,
  MPMX: 0.05571456, MSIN: 0.02675159, MTEL: 0.4638535, MYOR: 5.670238, NCKL: 78.80051, NICL: 0.04001446,
  NIKL: 0.09237936, NISP: 0.107495, PANI: 1.783932, PGAS: 0.02824819, PGEO: 0.02102151, PGUN: 0.06798754,
  PNBN: 0.06531221, PNLF: 0.2372686, PRDA: 0.01567073, PRDL: 4.040052, PSAB: 0.04885432, PSSI: 59.13,
  PTBA: 0.5105878, PTRO: 0.08290055, PWON: 0.8691615, RAJA: 0.06055615, RALS: 0.06992494, RANS: 0.03516618,
  RATU: 0.4010314, ROTI: 4.2842, SCMA: 96.77467, SGRO: 99.38204, SIDO: 0.1366014, SILO: 5.08168,
  SIMP: 1.344693, SMBR: 7.649317, SMDR: 0.8176929, SMGR: 0.0172267, SMRA: 7.007115, SMSM: 0.06925512,
  SOCI: 51.37574, SRTG: 3.517152, SSIA: 2.975228, SSMS: 0.08008227, TAPG: 3.793673, TBIG: 84.6184,
  TBLA: 0.09196458, TINS: 50.81839, TKIM: 8.842974, TLKM: 80.17981, TMAS: 0.102784, TOBA: 29.41348,
  TOTL: 0.5445839, TOWR: 0.01761643, TPIA: 0.8345403, TSPC: 5.823743, ULTJ: 0.7468343, UNIQ: 0.06856797,
  UNTR: 4.182065, UNVR: 0.08993656, WBSA: 0.6768099, WIFI: 17.52444, WOOD: 3.835657, WTON: 46.33745,
};

// Corporate actions inside a 200-day window. Stockbit's daily history is
// already adjusted for them; Bandar Metrics' cut-off uses the raw lots/trade,
// so window days before `date` are divided by `ratio` once the day being
// computed is on/after it. Dates and ratios are Stockbit's recorded ex-dates and
// factors (corporate-action endpoint), except ENRG's rights-issue ratio: the
// recorded price factor is 1.3205, but 1.345-1.370 is what reproduces
// Bandar Metrics on all three test days, so 1.355 is stored.
export const LPM_ACTIONS = {
  CUAN: [{ date: '2025-07-15', ratio: 10 }],
  DSSA: [{ date: '2024-07-18', ratio: 10 }, { date: '2026-04-09', ratio: 25 }],
  ENRG: [{ date: '2026-10-05', ratio: 1.355 }],
  MLPT: [{ date: '2026-07-21', ratio: 25 }],
  RAJA: [{ date: '2026-07-16', ratio: 5 }],
};
