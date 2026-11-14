#!/usr/bin/env node
// Print the HSC list in force on a date as JSON: { from, tickers }.
// fetch_stockbit.py calls this so the HSC schedule lives in one place
// (backend/lib/ihsg-rules.js), not copied into the Python job.
//   node jobs/bandarmology/hsc.mjs 2026-11-14
import { HSC_SCHEDULE } from '../../backend/lib/ihsg-rules.js';

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
let current = null;
for (const entry of HSC_SCHEDULE) if (entry.from <= date) current = entry;
console.log(JSON.stringify({ from: current?.from ?? null, tickers: current?.tickers ?? [] }));
