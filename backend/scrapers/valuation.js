// ──────────────────────────────────────────────
// Intrinsic value per ticker (Yahoo fundamentals-timeseries)
// ──────────────────────────────────────────────
// Two models, because one does not fit both kinds of business:
//
//   Operating companies → two-stage discounted free cash flow.
//   Banks / financials  → residual income (excess return).
//
// A bank's "free cash flow" is deposit and loan flow, not owner earnings —
// Yahoo reports 75T for BBCA, which values the balance sheet, not the
// business. The excess-return model is the standard alternative: a bank is
// worth its book value plus the present value of the returns it earns ABOVE
// its cost of equity. Both models return a per-share number, so the two sets
// still rank against each other in one list.
//
// NOTE: Yahoo's authenticated quoteSummary endpoint now returns 401. The
// fundamentals-timeseries endpoint used here needs no crumb or cookie.

import { fetchChart } from './yahoo.js';

const YAHOO_BASE = 'https://query1.finance.yahoo.com';

// Indonesia cost of capital: ~6.5% INDOGB 10y + ~6.5% equity risk premium.
// Applied flat to every name — this ranks companies, it does not price them.
// A per-name beta would imply a precision four annual reports cannot support.
export const DISCOUNT_RATE = 0.13;
export const TERMINAL_GROWTH = 0.04; // long-run nominal growth, below the discount rate
const FORECAST_YEARS = 5;
const MAX_STAGE1_GROWTH = 0.15;

// Annual carries the history; quarterly carries the freshness. Revenue stays
// annual only — a growth rate needs equal-length periods, and splicing a
// part-year onto a run of full years produces a rate that means nothing.
const FIELDS = [
  'annualFreeCashFlow',
  'annualTotalRevenue',
  'annualOrdinarySharesNumber',
  'annualTotalDebt',
  'annualCashAndCashEquivalents',
  'annualNetIncome',
  'annualStockholdersEquity',
  'annualCashDividendsPaid',
  'quarterlyFreeCashFlow',
  'quarterlyOrdinarySharesNumber',
  'quarterlyTotalDebt',
  'quarterlyCashAndCashEquivalents',
  'quarterlyNetIncome',
  'quarterlyStockholdersEquity',
  'quarterlyCashDividendsPaid',
].join(',');

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Annual fundamentals as { field: [{ date, value }] }, oldest first. */
export async function fetchFundamentals(ticker) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - (10 * 365 * 86400);
  const data = await getJSON(
    `${YAHOO_BASE}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}` +
    `?symbol=${encodeURIComponent(ticker)}&type=${FIELDS}&period1=${start}&period2=${end}&merge=false`
  );

  const out = {};
  for (const row of data?.timeseries?.result || []) {
    const field = Object.keys(row).find(k => k !== 'meta' && k !== 'timestamp');
    if (!field) continue;
    const entries = (row[field] || []).filter(Boolean);
    // A coal/energy exporter (ADRO, ITMG, MEDC, PGEO, ...) often files in USD
    // even though it trades in IDR on the IDX — Yahoo tags every line with the
    // filing currency, so grab it once rather than assuming IDR.
    if (!out.currency && entries[0]?.currencyCode) out.currency = entries[0].currencyCode;
    // Sorted oldest first: latest() reads the end of the series and cagr()
    // reads both ends, so a reversed series would report a decline as growth.
    out[field] = entries
      .map(v => ({ date: v.asOfDate, value: v.reportedValue?.raw }))
      .filter(v => typeof v.value === 'number' && v.date)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  return out;
}

/**
 * Sector/industry. The free search endpoint carries it; quoteSummary is 401.
 * Retried once: under the scrape's request rate this endpoint intermittently
 * returns nothing for a ticker it will happily resolve a moment later, and a
 * missing sector costs the ticker its valuation (see valuateTicker).
 */
export async function fetchProfile(ticker) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 800));
    try {
      const data = await getJSON(
        `${YAHOO_BASE}/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=1&newsCount=0`
      );
      const q = (data?.quotes || []).find(x => x.symbol === ticker);
      if (q?.sector) {
        return { sector: q.sector, industry: q.industry || null, name: q.longname || q.shortname || null };
      }
    } catch { /* retry, then give up below */ }
  }
  return { sector: null, industry: null, name: null };
}

const latest = series => (series?.length ? series[series.length - 1].value : null);

const MONTHS = 2629800000; // average month, in ms

/**
 * Sum of the last four quarters — but ONLY when those four really are one year.
 *
 * Yahoo's quarterly series has holes: BBCA is missing 2025-09-30, so its last
 * four points run Jun-25 → Jun-26 and cover fifteen months with a gap in the
 * middle. Adding those up is not a trailing year, it is a wrong number that
 * looks like a right one. Four consecutive quarters span nine months from the
 * first period end to the last; anything else is rejected and the caller falls
 * back to the annual figure.
 *
 * Roughly 40% of the IDX universe passes this test.
 */
export function trailingTwelveMonths(series) {
  if (!series || series.length < 4) return null;
  const last4 = series.slice(-4);
  const span = (new Date(last4[3].date) - new Date(last4[0].date)) / MONTHS;
  if (!(span > 8 && span < 10)) return null;
  return { date: last4[3].date, value: last4.reduce((sum, q) => sum + q.value, 0) };
}

/**
 * The freshest reading of a point-in-time figure — equity, debt, cash, share
 * count. Unlike a flow, these are a snapshot, so the newest one simply wins.
 */
export function mostRecent(...series) {
  let best = null;
  for (const s of series) {
    const point = s?.length ? s[s.length - 1] : null;
    if (point && (!best || point.date > best.date)) best = point;
  }
  return best;
}

/**
 * Middle value of a series. Free cash flow swings hard year to year — one asset
 * sale or working-capital release makes a single year unrepresentative, and a
 * DCF built on that one year turns it into a perpetuity. With only four annual
 * reports the median is the robust estimate of what the business normally earns.
 */
export function median(series) {
  if (!series?.length) return null;
  const sorted = series.map(s => s.value).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Compound annual growth across a series. Null unless both ends are positive. */
export function cagr(series) {
  if (!series || series.length < 2) return null;
  const first = series[0].value;
  const last = series[series.length - 1].value;
  if (!(first > 0) || !(last > 0)) return null;
  return Math.pow(last / first, 1 / (series.length - 1)) - 1;
}

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/**
 * Two-stage DCF. Five years of growth, then a Gordon terminal value.
 * Equity value = enterprise value − debt + cash.
 */
export function dcfPerShare(f) {
  // The trailing year joins the annual run as one more observation, the most
  // recent one, rather than replacing it. The median then stays robust AND
  // reflects the newest accounts — a single windfall still cannot set the
  // valuation, whether it lands in a filed year or the last four quarters.
  const flows = [...(f.annualFreeCashFlow || [])];
  const ttm = trailingTwelveMonths(f.quarterlyFreeCashFlow);
  if (ttm && (!flows.length || ttm.date > flows[flows.length - 1].date)) flows.push(ttm);

  const fcf0 = median(flows);
  const sharesPoint = mostRecent(f.annualOrdinarySharesNumber, f.quarterlyOrdinarySharesNumber);
  const shares = sharesPoint?.value;
  if (!(fcf0 > 0) || !(shares > 0)) return null;

  const growth = clamp(cagr(f.annualTotalRevenue) ?? 0.05, 0, MAX_STAGE1_GROWTH);

  let fcf = fcf0;
  let pv = 0;
  for (let year = 1; year <= FORECAST_YEARS; year++) {
    fcf *= (1 + growth);
    pv += fcf / Math.pow(1 + DISCOUNT_RATE, year);
  }
  const terminal = (fcf * (1 + TERMINAL_GROWTH)) / (DISCOUNT_RATE - TERMINAL_GROWTH);
  const enterprise = pv + terminal / Math.pow(1 + DISCOUNT_RATE, FORECAST_YEARS);

  const debt = mostRecent(f.annualTotalDebt, f.quarterlyTotalDebt);
  const cash = mostRecent(f.annualCashAndCashEquivalents, f.quarterlyCashAndCashEquivalents);
  const equity = enterprise - (debt?.value || 0) + (cash?.value || 0);

  return {
    fairValue: equity / shares,
    growth,
    model: 'dcf',
    basis: ttm ? 'trailing' : 'annual',
    asOf: flows[flows.length - 1]?.date || null,
  };
}

/**
 * Residual income (excess return) — the bank model.
 *
 *   value = book value + Σ PV[(ROE − Ke) × book value] + terminal
 *
 * Only returns above the cost of equity create value, so a bank earning
 * exactly Ke is worth exactly its book. Growth is the sustainable rate
 * ROE × retention — a bank cannot grow its balance sheet faster than the
 * equity it keeps, without raising capital.
 */
export function residualIncomePerShare(f) {
  // Book value and share count are snapshots — the newest filing wins outright.
  // Earnings and dividends are flows, so they need a whole year or nothing.
  const equityPoint = mostRecent(f.annualStockholdersEquity, f.quarterlyStockholdersEquity);
  const sharesPoint = mostRecent(f.annualOrdinarySharesNumber, f.quarterlyOrdinarySharesNumber);
  const ttmIncome = trailingTwelveMonths(f.quarterlyNetIncome);
  const ttmDividends = trailingTwelveMonths(f.quarterlyCashDividendsPaid);

  const equity = equityPoint?.value;
  const shares = sharesPoint?.value;
  const netIncome = ttmIncome ? ttmIncome.value : latest(f.annualNetIncome);
  if (!(equity > 0) || !(netIncome > 0) || !(shares > 0)) return null;

  const roe = netIncome / equity;
  // Pair the payout with the same period as the earnings it is measured against.
  const dividends = Math.abs(
    (ttmIncome && ttmDividends ? ttmDividends.value : latest(f.annualCashDividendsPaid)) || 0
  );
  const payout = clamp(dividends / netIncome, 0, 1);
  // Cap below the discount rate: a perpetual growth rate at or above the cost
  // of equity makes the terminal value infinite or negative.
  const growth = clamp(roe * (1 - payout), 0, TERMINAL_GROWTH);

  let book = equity;
  let pv = 0;
  for (let year = 1; year <= FORECAST_YEARS; year++) {
    pv += ((roe - DISCOUNT_RATE) * book) / Math.pow(1 + DISCOUNT_RATE, year);
    book *= (1 + growth);
  }
  const terminalRI = ((roe - DISCOUNT_RATE) * book) / (DISCOUNT_RATE - growth);
  const value = equity + pv + terminalRI / Math.pow(1 + DISCOUNT_RATE, FORECAST_YEARS);

  return {
    fairValue: value / shares,
    growth,
    roe,
    model: 'residual-income',
    basis: ttmIncome ? 'trailing' : 'annual',
    asOf: ttmIncome ? ttmIncome.date : (mostRecent(f.annualNetIncome)?.date || null),
  };
}

const FINANCIAL_SECTORS = new Set(['Financial Services', 'Financial']);

export function isFinancial(profile) {
  return FINANCIAL_SECTORS.has(profile?.sector);
}

// Every IDX ticker trades in IDR, but a handful of exporters (coal, energy,
// geothermal — ADRO, ITMG, MEDC, PGEO, ...) file their accounts in USD. Left
// unconverted, that per-share fair value lands ~15,000x too small and reads
// as the company being worthless. One rate, fetched once and reused for the
// whole run rather than once per ticker.
const fxRateToIdr = new Map([['IDR', Promise.resolve(1)]]);

function fetchFxToIdr(currency) {
  if (!fxRateToIdr.has(currency)) {
    const symbol = currency === 'USD' ? 'IDR=X' : `${currency}IDR=X`;
    fxRateToIdr.set(currency, fetchChart(symbol, 5)
      .then(bars => (bars.length ? bars[bars.length - 1].close : null))
      .catch(() => null));
  }
  return fxRateToIdr.get(currency);
}

/**
 * Value one ticker. Returns null when the inputs cannot support a valuation.
 *
 * An unknown sector is disqualifying, not a default. Yahoo's search endpoint
 * does not index every IDX code (MREI, a reinsurer, is one), and defaulting
 * those to the cash flow model values an insurer on its float — the exact
 * error the two-model split exists to prevent. Better to omit a company than
 * to publish a number built the wrong way.
 */
export async function valuateTicker(ticker) {
  const [fundamentals, profile, bars] = await Promise.all([
    fetchFundamentals(ticker).catch(() => ({})),
    fetchProfile(ticker).catch(() => ({ sector: null })),
    fetchChart(ticker, 10).catch(() => []),
  ]);

  const price = bars.length ? bars[bars.length - 1].close : null;
  if (!(price > 0)) return null;
  if (!profile.sector) return null;

  const financial = isFinancial(profile);
  const valued = financial ? residualIncomePerShare(fundamentals) : dcfPerShare(fundamentals);
  if (!valued || !isFinite(valued.fairValue)) return null;

  // Fundamentals and price must share a currency before they're compared —
  // a USD fair value against an IDR price is not a discount, it's a unit error.
  const fxRate = await fetchFxToIdr(fundamentals.currency || 'IDR');
  if (!(fxRate > 0)) return null;
  valued.fairValue *= fxRate;

  const reports = (financial ? fundamentals.annualNetIncome : fundamentals.annualFreeCashFlow) || [];

  return {
    ticker: ticker.replace(/\.JK$/, ''),
    name: profile.name || null,
    sector: profile.sector || null,
    price,
    fairValue: Math.round(valued.fairValue * 100) / 100,
    upside: valued.fairValue / price - 1,
    growth: valued.growth,
    roe: valued.roe ?? null,
    model: valued.model,
    // Which accounts this row rests on. Only about 40% of the universe files
    // four clean consecutive quarters, so the ranking is mixed-vintage: the
    // page prints asOf per row rather than implying one common date. `basis`
    // is not charted — it is kept because it is the only way to tell an annual
    // fallback from a trailing year that happens to end 31 December, which is
    // what you need when diagnosing why a row looks stale.
    basis: valued.basis,
    asOf: valued.asOf || reports[reports.length - 1]?.date || null,
  };
}

/**
 * Value every ticker, cheapest first. Rate limited like the breadth scrape;
 * each ticker costs three Yahoo calls, so this runs longer than the daily job.
 */
export async function buildValuations(tickers, { batchSize = 6, batchDelay = 1500 } = {}) {
  const rows = [];
  let failed = 0;

  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(t => valuateTicker(t).catch(() => null)));
    for (const row of results) {
      if (row) rows.push(row);
      else failed++;
    }
    if (i + batchSize < tickers.length) {
      await new Promise(r => setTimeout(r, batchDelay));
    }
  }

  rows.sort((a, b) => b.upside - a.upside);
  return { rows, failed };
}
