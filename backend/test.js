// ──────────────────────────────────────────────
// Unit Tests for IHSG A/D Backend
// Run with: node --test backend/test.js
// ──────────────────────────────────────────────

import { strictEqual, ok } from 'node:assert';
import { test, describe } from 'node:test';

import { buildDailyCounts, computeSeries } from './scrapers/yahoo.js';
import { FALLBACK_TICKERS } from './lib/tickers.js';

describe('computeSeries — output shape (no cumulative adLine)', () => {
  test('does not emit an adLine field (cumulative A/D Line was removed as an artifact)', () => {
    const series = computeSeries([
      { date: '2026-01-01', advances: 200, declines: 100, unchanged: 50 },
      { date: '2026-01-02', advances: 100, declines: 200, unchanged: 50 },
    ]);
    for (const d of series) {
      ok(!('adLine' in d), 'no adLine field should be present');
    }
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
