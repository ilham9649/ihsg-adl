// ──────────────────────────────────────────────
// Unit Tests for IHSG A/D Backend
// Run with: node --test backend/test.js
// ──────────────────────────────────────────────

import { strictEqual, ok } from 'node:assert';
import { test, describe } from 'node:test';

import { buildDailyCounts, computeSeries, isStaleComparison } from './scrapers/yahoo.js';
import { FALLBACK_TICKERS, IDX_TICKERS, DELISTED_TICKERS, getAllTickers } from './lib/tickers.js';
import { dcfPerShare, residualIncomePerShare, isFinancial, median, trailingTwelveMonths, mostRecent, DISCOUNT_RATE, TERMINAL_GROWTH } from './scrapers/valuation.js';
import { parseRssItems, mergeHeadlines, wibDateString, filterToday } from './scrapers/news.js';
import { parseScoreResponse } from './scrapers/sentiment.js';
import { weeklyCloses, ma200wSnapshot, summarizeMa200w } from './scrapers/ma200w.js';

// Helper: assert the A/D Line cumulative invariant (adLine is a genuine running
// sum of spreads, never resets).
function assertCumulativeInvariant(series, label = '') {
  ok(series.length > 0, `${label}: series must be non-empty`);
  let expected = 0;
  for (let i = 0; i < series.length; i++) {
    expected += series[i].spread;
    strictEqual(series[i].adLine, expected, `${label}: adLine[${i}]=${series[i].adLine} must equal cumulative spread ${expected}`);
  }
  strictEqual(series[series.length - 1].adLine, series.reduce((s, d) => s + d.spread, 0),
    `${label}: final adLine must equal sum of all spreads`);
}

describe('computeSeries — cumulative A/D Line (genuine, from adjusted-close breadth)', () => {
  test('adLine is present and a perfectly cumulative sum that never resets', () => {
    const series = computeSeries([
      { date: '2026-03-16', advances: 115, declines: 315, unchanged: 68 },
      { date: '2026-03-17', advances: 289, declines: 115, unchanged: 94 },
      { date: '2026-03-25', advances: 341, declines: 94, unchanged: 63 },
    ]);
    for (const d of series) ok('adLine' in d, 'adLine field present');
    assertCumulativeInvariant(series, 'first-3-days');
  });

  test('sorts output ascending by date', () => {
    const series = computeSeries([
      { date: '2026-03-25', advances: 341, declines: 94, unchanged: 63 },
      { date: '2026-03-16', advances: 115, declines: 315, unchanged: 68 },
      { date: '2026-03-17', advances: 289, declines: 115, unchanged: 94 },
    ]);
    strictEqual(series[0].date, '2026-03-16');
    strictEqual(series[2].date, '2026-03-25');
  });
});

describe('computeSeries — phantom-day filtering', () => {
  test('drops days where advances+declines == 0 (holidays / empty scrapes)', () => {
    const series = computeSeries([
      { date: '2026-05-13', advances: 200, declines: 100, unchanged: 199 },
      { date: '2026-05-14', advances: 0, declines: 0, unchanged: 499 },   // holiday, forward-filled
      { date: '2026-05-15', advances: 0, declines: 0, unchanged: 499 },
      { date: '2026-05-16', advances: 300, declines: 50, unchanged: 149 },
    ]);
    const dates = series.map(d => d.date);
    ok(!dates.includes('2026-05-14'));
    ok(!dates.includes('2026-05-15'));
    strictEqual(series.length, 2);
  });
});

describe('computeSeries — ratio & spread', () => {
  test('ratio = advances/declines, spread = advances - declines', () => {
    const [d] = computeSeries([{ date: '2026-01-01', advances: 300, declines: 100, unchanged: 50 }]);
    strictEqual(d.spread, 200);
    strictEqual(d.ratio, 3);
  });

  test('ratio is 100 when declines == 0 but advances > 0', () => {
    const [d] = computeSeries([{ date: '2026-01-01', advances: 400, declines: 0, unchanged: 50 }]);
    strictEqual(d.ratio, 100);
  });
});

describe('computeSeries — % Advancing (oscillating breadth)', () => {
  test('pctAdvancing = advances / (advances + declines) * 100, unchanged excluded', () => {
    const [d] = computeSeries([{ date: '2026-01-01', advances: 300, declines: 100, unchanged: 999 }]);
    strictEqual(d.pctAdvancing, 75); // 300 / 400, independent of unchanged
  });

  test('oscillates around 50 and stays within [0, 100]', () => {
    const series = computeSeries([
      { date: '2026-01-01', advances: 90, declines: 10, unchanged: 5 },   // 90%
      { date: '2026-01-02', advances: 20, declines: 80, unchanged: 5 },   // 20%
      { date: '2026-01-03', advances: 50, declines: 50, unchanged: 5 },   // 50%
    ]);
    strictEqual(series[0].pctAdvancing, 90);
    strictEqual(series[1].pctAdvancing, 20);
    strictEqual(series[2].pctAdvancing, 50);
    for (const d of series) ok(d.pctAdvancing >= 0 && d.pctAdvancing <= 100, 'in [0,100]');
  });
});

describe('computeSeries — McClellan oscillator', () => {
  test('McClellan is finite and warms up over the series (no monotonic drift)', () => {
    const counts = [];
    for (let i = 0; i < 200; i++) {
      const date = new Date(2024, 0, 1 + i).toISOString().split('T')[0];
      counts.push({ date, advances: 250 + (i % 50), declines: 250 - (i % 50), unchanged: 0 });
    }
    const series = computeSeries(counts);
    const last = series[series.length - 1];
    strictEqual(typeof last.mcClellan, 'number');
    ok(Number.isFinite(last.mcClellan), 'McClellan must be finite');
    ok(Math.abs(last.mcClellan) < 1000, 'McClellan in plausible range');
  });
});

describe('buildDailyCounts', () => {
  test('aggregates per-ticker directions into per-day counts', () => {
    const counts = buildDailyCounts([
      [
        { date: '2026-01-01', direction: 'advance' },
        { date: '2026-01-02', direction: 'decline' },
      ],
      [
        { date: '2026-01-01', direction: 'decline' },
        { date: '2026-01-02', direction: 'unchanged' },
      ],
    ]);
    strictEqual(counts['2026-01-01'].advances, 1);
    strictEqual(counts['2026-01-01'].declines, 1);
    strictEqual(counts['2026-01-02'].unchanged, 1);
    strictEqual(counts['2026-01-02'].declines, 1);
  });

  test('feeds through computeSeries (dropping phantom days)', () => {
    const allTickersAD = [
      [{ date: '2026-01-01', direction: 'advance' }, { date: '2026-01-02', direction: 'advance' }],
      [{ date: '2026-01-01', direction: 'advance' }, { date: '2026-01-02', direction: 'decline' }],
    ];
    const series = computeSeries(Object.values(buildDailyCounts(allTickersAD)));
    strictEqual(series.length, 2);
    // day1: 2 advances, 0 declines -> spread 2; day2: 1 advance, 1 decline -> spread 0
    strictEqual(series[0].spread, 2);
    strictEqual(series[1].spread, 0);
  });
});

describe('Ticker Discovery — FALLBACK_TICKERS', () => {
  test('fallback list is non-empty, valid, unique, and includes majors', () => {
    ok(FALLBACK_TICKERS.length > 0);
    ok(FALLBACK_TICKERS.every(t => /^[A-Z0-9]{3,6}$/.test(t)), 'all valid format');
    strictEqual(new Set(FALLBACK_TICKERS).size, FALLBACK_TICKERS.length, 'all unique');
    ok(['BBCA', 'BBRI', 'TLKM', 'ASII', 'UNVR'].every(t => FALLBACK_TICKERS.includes(t)), 'majors present');
  });
});

describe('Delisted universe', () => {
  test('delisted codes are valid, unique, and not already listed', async () => {
    ok(DELISTED_TICKERS.every(t => /^[A-Z0-9]{3,6}$/.test(t)), 'all valid format');
    strictEqual(new Set(DELISTED_TICKERS).size, DELISTED_TICKERS.length, 'all unique');
    // A code in both lists would be counted twice every day it traded.
    const listed = new Set(IDX_TICKERS);
    const overlap = DELISTED_TICKERS.filter(t => listed.has(t));
    strictEqual(overlap.length, 0, `delisted codes must not also be listed: ${overlap}`);

    const universe = await getAllTickers();
    strictEqual(universe.length, IDX_TICKERS.length + DELISTED_TICKERS.length, 'universe includes both');
    ok(universe.every(t => t.endsWith('.JK')), 'all suffixed for Yahoo');
    ok(universe.includes('MYRX.JK'), 'a delisted name reaches the scraper');
  });
});

describe('isStaleComparison — cross-gap price moves', () => {
  test('consecutive trading days compare normally', () => {
    strictEqual(isStaleComparison('2026-03-16', '2026-03-17'), false);
  });

  test('a weekend or holiday week still compares', () => {
    strictEqual(isStaleComparison('2026-03-27', '2026-04-08'), false, 'Idul Fitri break');
  });

  test('a months-long suspension does not compare', () => {
    // KRAH really did halt from 2016-10-20 to 2017-02-21 before resuming.
    strictEqual(isStaleComparison('2016-10-20', '2017-02-21'), true);
  });

  test('a reassigned ticker code does not splice two companies', () => {
    strictEqual(isStaleComparison('2015-06-30', '2018-01-04'), true);
  });
});

// ── Valuation ──

// One year of annual figures, oldest first, in the shape fetchFundamentals returns.
function annual(...values) {
  return values.map((value, i) => ({ date: `${2022 + i}-12-31`, value }));
}

describe('dcfPerShare — operating companies', () => {
  test('a no-growth company discounts to its hand-computed value', () => {
    // 100 FCF, flat revenue, 1 share, no debt or cash. Stage one is five flat
    // payments; only the terminal value grows at 4%.
    let expected = 0;
    for (let t = 1; t <= 5; t++) expected += 100 / Math.pow(1 + DISCOUNT_RATE, t);
    expected += ((100 * (1 + TERMINAL_GROWTH)) / (DISCOUNT_RATE - TERMINAL_GROWTH)) / Math.pow(1 + DISCOUNT_RATE, 5);

    const v = dcfPerShare({
      annualFreeCashFlow: annual(100, 100, 100),
      annualTotalRevenue: annual(500, 500, 500),
      annualOrdinarySharesNumber: annual(1, 1, 1),
    });
    ok(Math.abs(v.fairValue - expected) < 1e-6, `expected ${expected}, got ${v.fairValue}`);
    strictEqual(v.model, 'dcf');
  });

  test('net debt reduces equity value one-for-one', () => {
    const base = { annualFreeCashFlow: annual(100, 100), annualTotalRevenue: annual(500, 500), annualOrdinarySharesNumber: annual(10, 10) };
    const clean = dcfPerShare(base);
    const levered = dcfPerShare({ ...base, annualTotalDebt: annual(200, 200) });
    ok(Math.abs((clean.fairValue - levered.fairValue) - 20) < 1e-6, '200 of debt over 10 shares is 20 per share');
  });

  test('growth is capped, so a fast grower cannot run away with the ranking', () => {
    const v = dcfPerShare({
      annualFreeCashFlow: annual(100, 100),
      annualTotalRevenue: annual(100, 1000), // 900% revenue growth
      annualOrdinarySharesNumber: annual(1, 1),
    });
    ok(v.growth <= 0.15 + 1e-9, `growth ${v.growth} must be capped at 15%`);
  });

  test('negative free cash flow yields no valuation rather than a wrong one', () => {
    strictEqual(dcfPerShare({
      annualFreeCashFlow: annual(-50, -80),
      annualTotalRevenue: annual(500, 600),
      annualOrdinarySharesNumber: annual(1, 1),
    }), null);
  });
});

describe('residualIncomePerShare — banks', () => {
  test('a bank earning exactly its cost of equity is worth book value', () => {
    // ROE == discount rate leaves zero excess return at every horizon.
    const v = residualIncomePerShare({
      annualStockholdersEquity: annual(1000, 1000),
      annualNetIncome: annual(130, 130),
      annualOrdinarySharesNumber: annual(10, 10),
      annualCashDividendsPaid: annual(-130, -130),
    });
    ok(Math.abs(v.fairValue - 100) < 1e-6, `expected book value 100/share, got ${v.fairValue}`);
    strictEqual(v.model, 'residual-income');
  });

  test('a bank earning above its cost of equity is worth more than book', () => {
    const v = residualIncomePerShare({
      annualStockholdersEquity: annual(1000, 1000),
      annualNetIncome: annual(200, 200), // 20% ROE
      annualOrdinarySharesNumber: annual(10, 10),
      annualCashDividendsPaid: annual(-100, -100),
    });
    ok(v.fairValue > 100, `20% ROE must price above book, got ${v.fairValue}`);
    ok(Math.abs(v.roe - 0.2) < 1e-9);
  });

  test('a bank earning below its cost of equity is worth less than book', () => {
    const v = residualIncomePerShare({
      annualStockholdersEquity: annual(1000, 1000),
      annualNetIncome: annual(50, 50), // 5% ROE
      annualOrdinarySharesNumber: annual(10, 10),
      annualCashDividendsPaid: annual(-25, -25),
    });
    ok(v.fairValue < 100, `5% ROE must price below book, got ${v.fairValue}`);
  });

  test('retained-earnings growth stays below the discount rate', () => {
    // 40% ROE with nothing paid out implies 40% sustainable growth, which would
    // make the terminal value negative if it were not capped.
    const v = residualIncomePerShare({
      annualStockholdersEquity: annual(1000, 1000),
      annualNetIncome: annual(400, 400),
      annualOrdinarySharesNumber: annual(10, 10),
      annualCashDividendsPaid: annual(0, 0),
    });
    ok(v.growth < DISCOUNT_RATE, `growth ${v.growth} must stay below the discount rate`);
    ok(v.fairValue > 0 && isFinite(v.fairValue), `fair value must be finite and positive, got ${v.fairValue}`);
  });

  test('a loss-making bank yields no valuation', () => {
    strictEqual(residualIncomePerShare({
      annualStockholdersEquity: annual(1000, 1000),
      annualNetIncome: annual(-50, -80),
      annualOrdinarySharesNumber: annual(10, 10),
    }), null);
  });
});

describe('isFinancial — routes a ticker to the right model', () => {
  test('a bank uses the excess-return model', () => {
    ok(isFinancial({ sector: 'Financial Services', industry: 'Banks—Regional' }));
  });

  test('a telco does not', () => {
    strictEqual(isFinancial({ sector: 'Communication Services' }), false);
  });

  test('an unknown sector falls back to the cash flow model', () => {
    strictEqual(isFinancial({}), false);
  });
});

describe('median — normalizing a volatile cash flow series', () => {
  test('an odd-length series takes the middle value', () => {
    strictEqual(median(annual(10, 500, 20)), 20);
  });

  test('an even-length series averages the middle pair', () => {
    strictEqual(median(annual(10, 20, 30, 40)), 25);
  });

  test('one exceptional year does not set the valuation', () => {
    // Three ordinary years and one asset-sale year. Using the latest figure
    // would turn a windfall into a perpetuity; the median must not.
    const windfall = dcfPerShare({
      annualFreeCashFlow: annual(100, 100, 100, 900),
      annualTotalRevenue: annual(500, 500, 500, 500),
      annualOrdinarySharesNumber: annual(1, 1, 1, 1),
    });
    const ordinary = dcfPerShare({
      annualFreeCashFlow: annual(100, 100, 100, 100),
      annualTotalRevenue: annual(500, 500, 500, 500),
      annualOrdinarySharesNumber: annual(1, 1, 1, 1),
    });
    ok(windfall.fairValue < ordinary.fairValue * 2,
      `a single 9x year must not multiply the valuation: ${windfall.fairValue} vs ${ordinary.fairValue}`);
  });

  test('a company that is usually cash-negative is not valued on its one good year', () => {
    strictEqual(dcfPerShare({
      annualFreeCashFlow: annual(-100, -80, 300, -60),
      annualTotalRevenue: annual(500, 500, 500, 500),
      annualOrdinarySharesNumber: annual(1, 1, 1, 1),
    }), null);
  });
});

// Quarterly points, oldest first, in the shape fetchFundamentals returns.
function quarters(pairs) {
  return pairs.map(([date, value]) => ({ date, value }));
}

describe('trailingTwelveMonths — a year, or nothing', () => {
  test('four consecutive quarters sum to a trailing year', () => {
    const ttm = trailingTwelveMonths(quarters([
      ['2025-09-30', 10], ['2025-12-31', 20], ['2026-03-31', 30], ['2026-06-30', 40],
    ]));
    strictEqual(ttm.value, 100);
    strictEqual(ttm.date, '2026-06-30', 'reports the period it actually ends on');
  });

  test('a missing quarter is rejected rather than silently spanning fifteen months', () => {
    // BBCA really is missing 2025-09-30. Its last four points run Jun-25 to
    // Jun-26 — four values, but not four consecutive quarters.
    strictEqual(trailingTwelveMonths(quarters([
      ['2025-03-31', 14.1], ['2025-06-30', 14.9], ['2025-12-31', 14.1],
      ['2026-03-31', 14.7], ['2026-06-30', 14.9],
    ])), null);
  });

  test('fewer than four quarters yields nothing', () => {
    strictEqual(trailingTwelveMonths(quarters([
      ['2026-03-31', 30], ['2026-06-30', 40],
    ])), null);
  });

  test('only the most recent four are considered', () => {
    const ttm = trailingTwelveMonths(quarters([
      ['2024-03-31', 999],
      ['2025-09-30', 10], ['2025-12-31', 20], ['2026-03-31', 30], ['2026-06-30', 40],
    ]));
    strictEqual(ttm.value, 100, 'the stale 2024 point must not leak in');
  });
});

describe('mostRecent — snapshots take the newest filing', () => {
  test('a quarterly snapshot beats an older annual one', () => {
    const point = mostRecent(
      quarters([['2025-12-31', 100]]),
      quarters([['2026-06-30', 130]]),
    );
    strictEqual(point.value, 130);
  });

  test('the annual figure wins when no quarterly filing is newer', () => {
    const point = mostRecent(
      quarters([['2025-12-31', 100]]),
      quarters([['2025-06-30', 80]]),
    );
    strictEqual(point.value, 100);
  });

  test('missing series are skipped', () => {
    strictEqual(mostRecent(undefined, null, quarters([['2026-06-30', 7]])).value, 7);
  });
});

describe('valuation on trailing accounts', () => {
  test('the trailing year joins the annual run as one more observation', () => {
    // Four flat annual years at 100, then a trailing year at 300. The median of
    // five observations moves up one step — it does not jump to the newest.
    const withTrailing = dcfPerShare({
      annualFreeCashFlow: annual(100, 100, 100, 100),
      annualTotalRevenue: annual(500, 500, 500, 500),
      annualOrdinarySharesNumber: annual(1, 1, 1, 1),
      quarterlyFreeCashFlow: quarters([
        ['2026-06-30', 75], ['2026-03-31', 75], ['2025-12-31', 75], ['2025-09-30', 75],
      ].reverse()),
    });
    strictEqual(withTrailing.basis, 'trailing');
    strictEqual(withTrailing.asOf, '2026-06-30');
  });

  test('a holed quarterly series falls back to the annual basis', () => {
    const v = dcfPerShare({
      annualFreeCashFlow: annual(100, 100, 100),
      annualTotalRevenue: annual(500, 500, 500),
      annualOrdinarySharesNumber: annual(1, 1, 1),
      quarterlyFreeCashFlow: quarters([
        ['2025-03-31', 25], ['2025-06-30', 25], ['2025-12-31', 25], ['2026-03-31', 25],
      ]),
    });
    strictEqual(v.basis, 'annual', 'a gap must not be reported as a trailing year');
  });

  test('a bank uses trailing earnings against its newest book value', () => {
    const v = residualIncomePerShare({
      annualStockholdersEquity: annual(1000, 1000),
      annualNetIncome: annual(130, 130),
      annualOrdinarySharesNumber: annual(10, 10),
      annualCashDividendsPaid: annual(-130, -130),
      // Newer book, and a trailing year of earnings well above the annual run.
      quarterlyStockholdersEquity: quarters([['2026-06-30', 1000]]),
      quarterlyNetIncome: quarters([
        ['2025-09-30', 50], ['2025-12-31', 50], ['2026-03-31', 50], ['2026-06-30', 50],
      ]),
      quarterlyCashDividendsPaid: quarters([
        ['2025-09-30', -25], ['2025-12-31', -25], ['2026-03-31', -25], ['2026-06-30', -25],
      ]),
    });
    strictEqual(v.basis, 'trailing');
    ok(Math.abs(v.roe - 0.2) < 1e-9, `ROE must come from the trailing year, got ${v.roe}`);
    ok(v.fairValue > 100, 'a 20% ROE against 13% required prices above book');
  });
});

// ── Sentiment (news.js + sentiment.js) ──

// A real feed item looks like:
// <item><pubDate>Sat, 22 Aug 2026 10:00:05 +0700</pubDate><title><![CDATA[...]]></title><link>...</link></item>
const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>CNBC Indonesia Market</title>
<item>
<pubDate>Sat, 22 Aug 2026 10:00:05 +0700</pubDate>
<title><![CDATA[IHSG Ditutup Menguat 0,5% ke 7.500]]></title>
<link>https://www.cnbcindonesia.com/market/story-1</link>
</item>
<item>
<pubDate>Sat, 22 Aug 2026 09:15:00 +0700</pubDate>
<title>Rupiah &amp; Dolar AS Bergerak Variatif</title>
<link>https://www.cnbcindonesia.com/market/story-2</link>
</item>
<item>
<pubDate>Sat, 22 Aug 2026 08:00:00 +0700</pubDate>
<title><![CDATA[IHSG Anjlok 2,1% ke 7.100]]></title>
<description><![CDATA[ <img src="https://example.com/x.jpeg"/> Investor asing bukukan net sell Rp1,2 triliun di tengah kekhawatiran suku bunga&nbsp;(data BEI).]]></description>
<link>https://www.cnbcindonesia.com/market/story-2b</link>
</item>
<item>
<pubDate>Fri, 21 Aug 2026 23:00:00 +0700</pubDate>
<link>https://www.cnbcindonesia.com/market/story-3-no-title</link>
</item>
<item>
<pubDate>Fri, 21 Aug 2026 22:00:00 +0700
<title><![CDATA[Truncated item, never closed]]></title>
</channel></rss>`;

describe('parseRssItems — CNBC Indonesia market RSS', () => {
  test('extracts CDATA-wrapped titles (the normal case)', () => {
    const items = parseRssItems(RSS_FIXTURE);
    strictEqual(items[0].title, 'IHSG Ditutup Menguat 0,5% ke 7.500');
    strictEqual(items[0].link, 'https://www.cnbcindonesia.com/market/story-1');
    ok(items[0].pubDate instanceof Date && !isNaN(items[0].pubDate), 'pubDate parsed');
  });

  test('decodes HTML entities in a plain (non-CDATA) title', () => {
    const items = parseRssItems(RSS_FIXTURE);
    strictEqual(items[1].title, 'Rupiah & Dolar AS Bergerak Variatif');
  });

  test('folds <description> into title, stripping embedded markup and decoding &nbsp;', () => {
    const items = parseRssItems(RSS_FIXTURE);
    strictEqual(
      items[2].title,
      'IHSG Anjlok 2,1% ke 7.100 — Investor asing bukukan net sell Rp1,2 triliun di tengah kekhawatiran suku bunga (data BEI).'
    );
    ok(!items[2].title.includes('&nbsp;'), '&nbsp; is an HTML entity, not valid XML — must not leak through undecoded');
  });

  test('skips a malformed/truncated item instead of throwing', () => {
    // Calling this at all is the throw check — node:test fails the test if it
    // throws. The no-title item is filtered, the never-closed item never
    // matches as a block at all — only the three well-formed items survive.
    const items = parseRssItems(RSS_FIXTURE);
    strictEqual(items.length, 3);
  });

  test('empty or garbage input yields an empty list, not a throw', () => {
    strictEqual(parseRssItems('').length, 0);
    strictEqual(parseRssItems('not xml at all').length, 0);
  });
});

describe('mergeHeadlines — combining multiple news sources', () => {
  const h = (title, pubDate) => ({ title, link: `https://x/${title}`, pubDate: new Date(pubDate) });

  test('dedupes the same story covered by more than one outlet, case-insensitively', () => {
    const merged = mergeHeadlines([
      [h('IHSG Ditutup Menguat', '2026-08-23T01:00:00Z')],
      [h('ihsg ditutup menguat', '2026-08-23T01:05:00Z'), h('Rupiah Melemah', '2026-08-23T00:00:00Z')],
    ]);
    strictEqual(merged.length, 2, 'the repeated story counts once');
  });

  test('sorts newest first across all sources, not source-by-source', () => {
    const merged = mergeHeadlines([
      [h('Old from source A', '2026-08-20T00:00:00Z')],
      [h('New from source B', '2026-08-23T00:00:00Z'), h('Mid from source B', '2026-08-22T00:00:00Z')],
    ]);
    strictEqual(merged[0].title, 'New from source B');
    strictEqual(merged[1].title, 'Mid from source B');
    strictEqual(merged[2].title, 'Old from source A');
  });

  test('an empty list of lists (every source failed) yields an empty array, not a throw', () => {
    strictEqual(mergeHeadlines([]).length, 0);
  });
});

describe('wibDateString — UTC+7, no DST', () => {
  test('a UTC timestamp already past 17:00 has rolled to the next WIB day', () => {
    // 17:30 UTC + 7h = 00:30 the next calendar day in WIB.
    strictEqual(wibDateString(new Date('2026-08-21T17:30:00Z')), '2026-08-22');
  });

  test('a UTC timestamp just before the boundary is still the same WIB day', () => {
    // 16:59 UTC + 7h = 23:59 the same calendar day in WIB.
    strictEqual(wibDateString(new Date('2026-08-21T16:59:00Z')), '2026-08-21');
  });
});

describe('filterToday — headlines straddling the UTC/WIB day boundary', () => {
  test('keeps only headlines whose WIB calendar day matches, across the boundary', () => {
    const headlines = [
      { title: 'just after WIB midnight', pubDate: new Date('2026-08-21T17:30:00Z') }, // WIB 2026-08-22
      { title: 'just before WIB midnight', pubDate: new Date('2026-08-21T16:59:00Z') }, // WIB 2026-08-21
      { title: 'mid-morning WIB', pubDate: new Date('2026-08-22T03:00:00Z') }, // WIB 2026-08-22
      { title: 'no pubDate', pubDate: null },
    ];
    const kept = filterToday(headlines, '2026-08-22');
    strictEqual(kept.length, 2);
    ok(kept.every(h => h.title !== 'just before WIB midnight'));
    ok(kept.every(h => h.title !== 'no pubDate'));
  });
});

describe('parseScoreResponse — tolerant LLM reply parsing', () => {
  test('valid JSON yields the correct fields', () => {
    const v = parseScoreResponse('{"score": 42, "label": "bullish", "summary": "Markets rallied on strong earnings."}');
    strictEqual(v.score, 42);
    strictEqual(v.label, 'bullish');
    strictEqual(v.summary, 'Markets rallied on strong earnings.');
  });

  test('a score outside +/-100 is clamped', () => {
    strictEqual(parseScoreResponse('{"score": 150, "label": "x", "summary": "s"}').score, 100);
    strictEqual(parseScoreResponse('{"score": -999, "label": "x", "summary": "s"}').score, -100);
  });

  test('a non-numeric or missing score yields null', () => {
    strictEqual(parseScoreResponse('{"score": "very bullish", "label": "x", "summary": "s"}'), null);
    strictEqual(parseScoreResponse('{"label": "x", "summary": "s"}'), null);
  });

  test('JSON wrapped in prose or a ```json fence is still extracted', () => {
    const prose = `Sure, here is my assessment:\n{"score": -30, "label": "bearish", "summary": "Selloff on rate fears."}\nLet me know if you need more.`;
    strictEqual(parseScoreResponse(prose).score, -30);

    const fenced = '```json\n{"score": 15, "label": "neutral", "summary": "Mixed signals."}\n```';
    strictEqual(parseScoreResponse(fenced).score, 15);
  });

  test('pure garbage text yields null', () => {
    strictEqual(parseScoreResponse('I cannot complete this request.'), null);
    strictEqual(parseScoreResponse(''), null);
  });
});

// Bars 7 days apart land in a distinct ISO week every time (a week is always
// exactly 7 days, so this holds across year boundaries too) — a convenient way
// to build an exact N-week fixture without depending on a real trading calendar.
function weeklyBars(count, closeFn, startDate = '2022-01-03') {
  const start = new Date(startDate + 'T00:00:00Z');
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i * 7);
    return { date: d.toISOString().slice(0, 10), adjClose: closeFn(i) };
  });
}

describe('weeklyCloses — ISO-week bucketing (same convention as frontend/app.js)', () => {
  test('one bar per week yields one close per week, in order', () => {
    const bars = weeklyBars(5, i => 100 + i);
    const weeks = weeklyCloses(bars);
    strictEqual(weeks.length, 5);
    strictEqual(weeks[4].close, 104);
  });

  test('multiple bars in the same ISO week collapse to the LAST close', () => {
    const bars = [
      { date: '2026-08-17', adjClose: 100 }, // Monday
      { date: '2026-08-18', adjClose: 105 },
      { date: '2026-08-19', adjClose: 98 },  // last bar of that week wins
      { date: '2026-08-24', adjClose: 110 }, // next Monday, new week
    ];
    const weeks = weeklyCloses(bars);
    strictEqual(weeks.length, 2);
    strictEqual(weeks[0].close, 98);
    strictEqual(weeks[1].close, 110);
  });
});

describe('ma200wSnapshot — distance from the 200-week average', () => {
  test('fewer than 200 weekly bars yields null (too young to have a line)', () => {
    strictEqual(ma200wSnapshot(weeklyBars(199, () => 100)), null);
  });

  test('a flat 200-week series sits exactly on its own average', () => {
    const snap = ma200wSnapshot(weeklyBars(200, () => 100));
    strictEqual(snap.price, 100);
    strictEqual(snap.ma200w, 100);
    strictEqual(snap.pctFromMa, 0);
  });

  test('the latest close pulls the reading above the trailing average', () => {
    // 199 weeks at 100, then one week at 130: ma = (199*100+130)/200 = 100.15.
    const bars = weeklyBars(200, i => (i === 199 ? 130 : 100));
    const snap = ma200wSnapshot(bars);
    strictEqual(snap.price, 130);
    strictEqual(snap.ma200w, 100.15);
    strictEqual(snap.pctFromMa, 29.8); // (130-100.15)/100.15 * 100, rounded to 1dp
  });

  test('no bars at all yields null rather than throwing', () => {
    strictEqual(ma200wSnapshot([]), null);
    strictEqual(ma200wSnapshot(null), null);
  });

  test('a suspended ticker\'s stale last bar is excluded, not read as sitting on the line', () => {
    const bars = weeklyBars(200, () => 100); // last bar dated ~2025-09-27 (200 weeks from 2022-01-03)
    const lastBarDate = bars[bars.length - 1].date;
    // Without a reference date, the last bar IS "today" — no staleness check.
    ok(ma200wSnapshot(bars) !== null);
    // Same bars, but "today" is over a year past the last trade: this ticker
    // has gone silent, not settled motionless on its average.
    strictEqual(ma200wSnapshot(bars, '2026-08-23'), null);
    // A reference date still close to the last bar is fine.
    ok(ma200wSnapshot(bars, lastBarDate) !== null);
  });
});

describe('summarizeMa200w — market-wide reading from per-ticker snapshots', () => {
  test('counts within the band and below the line', () => {
    const rows = [{ pctFromMa: 2 }, { pctFromMa: -3 }, { pctFromMa: 8 }, { pctFromMa: -1 }];
    const s = summarizeMa200w(rows, 5);
    strictEqual(s.universeCount, 4);
    strictEqual(s.pctNear, 75); // 2, -3, -1 are within +/-5; 8 is not
    strictEqual(s.pctBelow, 50); // -3 and -1 sit below their own line
  });

  test('an empty universe reads as zero, not NaN or a throw', () => {
    const s = summarizeMa200w([]);
    strictEqual(s.universeCount, 0);
    strictEqual(s.pctNear, 0);
    strictEqual(s.pctBelow, 0);
  });
});
