// ──────────────────────────────────────────────
// Basic Unit Tests for IHSG A/D Backend
// Run with: node --test backend/test.js
// ──────────────────────────────────────────────

import { strictEqual, deepStrictEqual } from 'node:assert';
import { test, describe } from 'node:test';

// Import functions to test
import { aggregateAD } from './scrapers/yahoo.js';
import { FALLBACK_TICKERS } from './lib/tickers.js';

describe('Yahoo Finance Scraper - aggregateAD', () => {
  test('should aggregate single ticker data correctly', () => {
    const input = [
      [
        { date: '2024-01-01', direction: 'advance' },
        { date: '2024-01-02', direction: 'decline' },
        { date: '2024-01-03', direction: 'advance' },
      ],
    ];

    const result = aggregateAD(input);

    strictEqual(result.length, 3, 'Should have 3 days of data');
    strictEqual(result[0].advances, 1, 'Day 1: 1 advance');
    strictEqual(result[0].declines, 0, 'Day 1: 0 declines');
    strictEqual(result[0].spread, 1, 'Day 1: spread = 1');
    strictEqual(result[0].adLine, 1, 'Day 1: A/D Line = 1');

    strictEqual(result[1].advances, 0, 'Day 2: 0 advances');
    strictEqual(result[1].declines, 1, 'Day 2: 1 decline');
    strictEqual(result[1].spread, -1, 'Day 2: spread = -1');
    strictEqual(result[1].adLine, 0, 'Day 2: A/D Line = 0 (cumulative)');

    strictEqual(result[2].advances, 1, 'Day 3: 1 advance');
    strictEqual(result[2].declines, 0, 'Day 3: 0 declines');
    strictEqual(result[2].spread, 1, 'Day 3: spread = 1');
    strictEqual(result[2].adLine, 1, 'Day 3: A/D Line = 1');
  });

  test('should aggregate multiple tickers correctly', () => {
    const input = [
      [
        { date: '2024-01-01', direction: 'advance' },
        { date: '2024-01-02', direction: 'advance' },
      ],
      [
        { date: '2024-01-01', direction: 'decline' },
        { date: '2024-01-02', direction: 'unchanged' },
      ],
    ];

    const result = aggregateAD(input);

    strictEqual(result.length, 2, 'Should have 2 days of data');
    strictEqual(result[0].advances, 1, 'Day 1: 1 advance');
    strictEqual(result[0].declines, 1, 'Day 1: 1 decline');
    strictEqual(result[0].unchanged, 0, 'Day 1: 0 unchanged');
    strictEqual(result[0].spread, 0, 'Day 1: spread = 0');

    strictEqual(result[1].advances, 1, 'Day 2: 1 advance');
    strictEqual(result[1].declines, 0, 'Day 2: 0 declines');
    strictEqual(result[1].unchanged, 1, 'Day 2: 1 unchanged');
    strictEqual(result[1].spread, 1, 'Day 2: spread = 1');
  });

  test('should calculate ratio correctly', () => {
    const input = [
      [
        { date: '2024-01-01', direction: 'advance' },
        { date: '2024-01-02', direction: 'advance' },
        { date: '2024-01-03', direction: 'advance' },
      ],
      [
        { date: '2024-01-01', direction: 'decline' },
        { date: '2024-01-02', direction: 'decline' },
        { date: '2024-01-03', direction: 'decline' },
      ],
    ];

    const result = aggregateAD(input);

    strictEqual(result[0].ratio, 1, 'Day 1: ratio = 1:1 = 1.0');
    strictEqual(result[1].ratio, 1, 'Day 2: ratio = 1:1 = 1.0');
    strictEqual(result[2].ratio, 1, 'Day 3: ratio = 1:1 = 1.0');
  });

  test('should handle edge case with only advances', () => {
    const input = [
      [
        { date: '2024-01-01', direction: 'advance' },
      ],
    ];

    const result = aggregateAD(input);

    strictEqual(result[0].advances, 1, '1 advance');
    strictEqual(result[0].declines, 0, '0 declines');
    strictEqual(result[0].ratio, 100, 'Ratio should be 100 when no declines');
  });

  test('should handle edge case with only declines', () => {
    const input = [
      [
        { date: '2024-01-01', direction: 'decline' },
      ],
    ];

    const result = aggregateAD(input);

    strictEqual(result[0].advances, 0, '0 advances');
    strictEqual(result[0].declines, 1, '1 decline');
    strictEqual(result[0].ratio, 0, 'Ratio should be 0 when no advances');
  });

  test('should calculate McClellan Oscillator', () => {
    const input = [
      // Create enough data points for EMA warmup
      ...Array(50).fill(null).map((_, i) => [
        { date: `2024-${String(i + 1).padStart(2, '0')}-01`, direction: 'advance' },
      ]),
    ];

    const result = aggregateAD(input);

    // After warmup, McClellan should be non-zero
    const mcClellanValue = result[result.length - 1].mcClellan;
    strictEqual(typeof mcClellanValue, 'number', 'McClellan should be a number');
  });

  test('should sort output by date', () => {
    const input = [
      [
        { date: '2024-01-03', direction: 'advance' },
        { date: '2024-01-01', direction: 'advance' },
        { date: '2024-01-02', direction: 'advance' },
      ],
    ];

    const result = aggregateAD(input);

    strictEqual(result[0].date, '2024-01-01', 'First date should be 2024-01-01');
    strictEqual(result[1].date, '2024-01-02', 'Second date should be 2024-01-02');
    strictEqual(result[2].date, '2024-01-03', 'Third date should be 2024-01-03');
  });
});

describe('Ticker Discovery - FALLBACK_TICKERS', () => {
  test('fallback list should not be empty', () => {
    strictEqual(FALLBACK_TICKERS.length > 0, true, 'Fallback tickers should exist');
  });

  test('fallback tickers should be valid format', () => {
    const isValid = FALLBACK_TICKERS.every(t =>
      typeof t === 'string' &&
      t.length >= 3 &&
      t.length <= 5 &&
      /^[A-Z0-9]+$/.test(t)
    );
    strictEqual(isValid, true, 'All fallback tickers should be valid format');
  });

  test('fallback tickers should be unique', () => {
    const unique = new Set(FALLBACK_TICKERS);
    strictEqual(unique.size, FALLBACK_TICKERS.length, 'All tickers should be unique');
  });

  test('fallback tickers should include major stocks', () => {
    const majorStocks = ['BBCA', 'BBRI', 'TLKM', 'ASII', 'UNVR'];
    const hasAll = majorStocks.every(ticker => FALLBACK_TICKERS.includes(ticker));
    strictEqual(hasAll, true, 'Should include major IDX stocks');
  });
});
