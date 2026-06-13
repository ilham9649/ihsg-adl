// ──────────────────────────────────────────────
// Unit Tests for IHSG A/D Backend
// Run with: node --test backend/test.js
// ──────────────────────────────────────────────

import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { test, describe } from 'node:test';

import { buildDailyCounts, computeSeries } from './scrapers/yahoo.js';
import { FALLBACK_TICKERS } from './lib/tickers.js';

// Helper: assert the A/D Line cumulative invariant that was previously broken.
function assertCumulativeInvariant(series, label = '') {
  ok(series.length > 0, `${label}: series must be non-empty`);
  strictEqual(series[0].adLine, series[0].spread, `${label}: adLine[0] must equal spread[0]`);
  let expected = 0;
  for (let i = 0; i < series.length; i++) {
    expected += series[i].spread;
    strictEqual(series[i].adLine, expected, `${label}: adLine[${i}]=${series[i].adLine} must equal cumulative spread ${expected}`);
  }
  strictEqual(series[series.length - 1].adLine, series.reduce((s, d) => s + d.spread, 0),
    `${label}: final adLine must equal sum of all spreads`);
}

describe('computeSeries — cumulative invariant (regression for the +200 chain-break bug)', () => {
  test('adLine is a perfectly cumulative sum that never resets', () => {
    const counts = [
      { date: '2026-03-16', advances: 115, declines: 315, unchanged: 68 },
      { date: '2026-03-17', advances: 289, declines: 115, unchanged: 94 },
      { date: '2026-03-25', advances: 341, declines: 94, unchanged: 63 },
    ];
    // Reproduces the EXACT first 3 days that previously broke (day2 reset to +174).
    const series = computeSeries(counts);
    assertCumulativeInvariant(series, 'first-3-days');
    // Sanity: day1 spread = -200, day2 expected adLine = -200 + 174 = -26 (NOT 174)
    strictEqual(series[1].adLine, -26, 'day2 adLine must be -26, not the buggy +174');
  });

  test('invariant holds for a large randomized series', () => {
    // Deterministic pseudo-random counts (no Math.random in this environment)
    const counts = [];
    let seed = 42;
    for (let i = 0; i < 500; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const advances = 100 + (seed % 400);
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const declines = 100 + (seed % 400);
      const date = new Date(2023, 0, 1 + i).toISOString().split('T')[0];
      counts.push({ date, advances, declines, unchanged: 500 - advances - declines });
    }
    const series = computeSeries(counts);
    assertCumulativeInvariant(series, '500-day');
    ok(series.length === 500);
  });

  test('invariant holds when series is provided out of order', () => {
    const counts = [
      { date: '2026-03-25', advances: 341, declines: 94, unchanged: 63 },
      { date: '2026-03-16', advances: 115, declines: 315, unchanged: 68 },
      { date: '2026-03-17', advances: 289, declines: 115, unchanged: 94 },
    ];
    const series = computeSeries(counts);
    assertCumulativeInvariant(series, 'unsorted-input');
    strictEqual(series[0].date, '2026-03-16', 'output must be sorted ascending');
  });
});

describe('computeSeries — phantom-day filtering', () => {
  test('drops days where advances+declines == 0 (holidays / empty scrapes)', () => {
    const counts = [
      { date: '2026-05-13', advances: 200, declines: 100, unchanged: 199 }, // real day
      { date: '2026-05-14', advances: 0, declines: 0, unchanged: 499 },     // holiday, forward-filled
      { date: '2026-05-15', advances: 0, declines: 0, unchanged: 499 },     // holiday, forward-filled
      { date: '2026-05-16', advances: 300, declines: 50, unchanged: 149 },  // real day
    ];
    const series = computeSeries(counts);
    const dates = series.map(d => d.date);
    ok(!dates.includes('2026-05-14'), 'holiday 05-14 must be dropped');
    ok(!dates.includes('2026-05-15'), 'holiday 05-15 must be dropped');
    strictEqual(series.length, 2, 'only the 2 real days remain');
  });

  test('cumulative chain is consistent across a gap created by dropped days', () => {
    const counts = [
      { date: '2026-05-13', advances: 300, declines: 100, unchanged: 99 },  // spread +200
      { date: '2026-05-14', advances: 0, declines: 0, unchanged: 499 },     // dropped
      { date: '2026-05-16', advances: 100, declines: 300, unchanged: 99 },  // spread -200
    ];
    const series = computeSeries(counts);
    assertCumulativeInvariant(series, 'with-gap');
    strictEqual(series[0].adLine, 200);
    strictEqual(series[1].adLine, 0, 'after gap, adLine = 200 + (-200) = 0');
  });
});

describe('computeSeries — ratio & spread', () => {
  test('ratio = advances/declines, spread = advances - declines', () => {
    const series = computeSeries([
      { date: '2026-01-01', advances: 300, declines: 100, unchanged: 50 },
    ]);
    strictEqual(series[0].spread, 200);
    strictEqual(series[0].ratio, 3);
  });

  test('ratio is 100 when declines == 0 but advances > 0', () => {
    const series = computeSeries([
      { date: '2026-01-01', advances: 400, declines: 0, unchanged: 50 },
    ]);
    strictEqual(series[0].ratio, 100);
  });
});

describe('computeSeries — McClellan oscillator', () => {
  test('McClellan is a finite number and warms up over the series', () => {
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
    const allTickersAD = [
      [
        { date: '2026-01-01', direction: 'advance' },
        { date: '2026-01-02', direction: 'decline' },
      ],
      [
        { date: '2026-01-01', direction: 'decline' },
        { date: '2026-01-02', direction: 'unchanged' },
      ],
    ];
    const counts = buildDailyCounts(allTickersAD);
    strictEqual(counts['2026-01-01'].advances, 1);
    strictEqual(counts['2026-01-01'].declines, 1);
    strictEqual(counts['2026-01-02'].unchanged, 1);
    strictEqual(counts['2026-01-02'].declines, 1);
  });

  test('feeds through computeSeries with a consistent chain', () => {
    const allTickersAD = [
      [{ date: '2026-01-01', direction: 'advance' }, { date: '2026-01-02', direction: 'advance' }],
      [{ date: '2026-01-01', direction: 'advance' }, { date: '2026-01-02', direction: 'decline' }],
    ];
    const series = computeSeries(Object.values(buildDailyCounts(allTickersAD)));
    assertCumulativeInvariant(series, 'buildDailyCounts->computeSeries');
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
