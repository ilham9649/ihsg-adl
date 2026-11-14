// ──────────────────────────────────────────────
// Does LPM predict returns? Cross-sectional backtest, alone and combined.
// ──────────────────────────────────────────────
// Usage:
//   node research/lpm-backtest.mjs <bm_indicators.json> [--refresh-prices]
//
// Input: Bandar Metrics' published daily series per stock — LPM, Foreign Flow,
// Volume Rotation, Intensity — as { CODE: { lpm: [[YYMMDD, value], ...], ... } }
// (exported from the chart; not committed). Prices: Yahoo adjusted closes,
// cached in research/data/prices.json.
//
// Method — kept deliberately plain so nothing is tuned to the answer:
//   - Every signal is known after the close of day t; the position is entered at
//     the close of t+1 and held h sessions (5, 10, 20). No same-day look-ahead.
//   - Signals are scale-free per stock (LPM's per-stock constant drops out):
//     a 20-day change divided by that stock's own daily-change volatility over
//     the trailing 250 sessions. Levels (Volume Rotation, Intensity) are
//     z-scored against their own trailing 250 sessions.
//   - Each rebalance date (every h sessions, non-overlapping) ranks the
//     universe: information coefficient = Spearman(signal, forward return);
//     the top fifth is held equal-weight against the whole universe's average.
//   - Costs: 0.15% to buy, 0.25% to sell (IDX fee + levy + 0.1% sales tax),
//     charged on the share of the top fifth that changes at each rebalance.
//   - Liquidity: a stock counts on a date only if its median traded value over
//     the last 20 sessions is ≥ Rp 1bn and its close ≥ Rp 50.
//   - Combinations are equal-weight averages of cross-sectional ranks — no
//     fitted weights, so in-sample and out-of-sample are the same thing.
//
// Known biases, stated rather than hidden: the universe is ~170 stocks that are
// listed today (survivors) and were picked because they are liquid; LPM values
// from Aug 2020 to ~2022 come from Bandar Metrics' older broker feed.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fetchChart } from '../backend/scrapers/yahoo.js';

const [, , inputPath, ...flags] = process.argv;
if (!inputPath) { console.error('usage: node research/lpm-backtest.mjs <bm_indicators.json> [--refresh-prices]'); process.exit(1); }
const DATA_DIR = new URL('./data/', import.meta.url);
mkdirSync(DATA_DIR, { recursive: true });

const HORIZONS = [5, 10, 20];
const VOL_WINDOW = 250, MIN_HISTORY = 120, CHANGE_DAYS = 20;
const BUY_COST = 0.0015, SELL_COST = 0.0025;
const MIN_VALUE = 1e9, MIN_PRICE = 50, MIN_STOCKS = 30;
const PERIODS = [
  ['2021-01-01', '2022-12-31', '2021–22 (older BM broker feed)'],
  ['2023-01-01', '2024-12-31', '2023–24'],
  ['2025-01-01', '2026-12-31', '2025–26'],
];

// ── data ──────────────────────────────────────
const bm = JSON.parse(readFileSync(inputPath, 'utf8'));
const codes = Object.keys(bm).filter(c => bm[c].lpm?.length > MIN_HISTORY);
const yymmdd = s => `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;

const priceFile = new URL('prices.json', DATA_DIR);
let prices = existsSync(priceFile) && !flags.includes('--refresh-prices') ? JSON.parse(readFileSync(priceFile, 'utf8')) : {};
const missing = codes.filter(c => !prices[c]);
for (let i = 0; i < missing.length; i += 6) {
  await Promise.all(missing.slice(i, i + 6).map(async c => {
    try { prices[c] = (await fetchChart(`${c}.JK`, 2600)).map(q => [q.date, q.adjClose, q.close, q.volume]); }
    catch (e) { console.error(`price ${c}: ${e.message}`); prices[c] = []; }
  }));
  await new Promise(r => setTimeout(r, 1500));
  process.stderr.write(`prices ${Math.min(i + 6, missing.length)}/${missing.length}\r`);
}
if (missing.length) writeFileSync(priceFile, JSON.stringify(prices));

// ── per-stock aligned series and signals ──────
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

const stocks = {};   // code -> { dates[], idx{date:i}, adj[], value[], sig{name: []} }
for (const c of codes) {
  const px = prices[c] || [];
  if (px.length < MIN_HISTORY) continue;
  const ind = {};
  for (const name of ['lpm', 'foreign_flow', 'volume_rotation', 'intensity']) {
    ind[name] = new Map((bm[c][name] || []).map(([d, v]) => [yymmdd(d), v]));
  }
  const dates = px.map(p => p[0]), adj = px.map(p => p[1]), close = px.map(p => p[2]);
  const value = px.map(p => p[2] * p[3]);
  const n = dates.length;
  const ff = (name) => { let last = null; return dates.map(d => { const v = ind[name].get(d); if (v != null) last = v; return last; }); };
  const lpm = ff('lpm'), flow = ff('foreign_flow');
  const vr = dates.map(d => ind.volume_rotation.get(d) ?? null), it = dates.map(d => ind.intensity.get(d) ?? null);
  const sig = { lpm20: [], lpm60: [], ff20: [], vr: [], intensity: [], mom20: [], mom60: [], rev5: [], div: [] };
  const flowZ = (series, i, days) => {
    if (i < MIN_HISTORY || series[i] == null || series[i - days] == null) return null;
    const ch = [];
    for (let j = Math.max(1, i - VOL_WINDOW + 1); j <= i; j++) if (series[j] != null && series[j - 1] != null) ch.push(series[j] - series[j - 1]);
    const s = ch.length > 60 ? sd(ch) : 0;
    return s > 0 ? (series[i] - series[i - days]) / (s * Math.sqrt(days)) : null;
  };
  const levelZ = (series, i, tf = x => x) => {
    if (i < MIN_HISTORY || series[i] == null) return null;
    const h = [];
    for (let j = Math.max(0, i - VOL_WINDOW + 1); j <= i; j++) if (series[j] != null && series[j] > 0) h.push(tf(series[j]));
    const s = h.length > 60 ? sd(h) : 0;
    return s > 0 && series[i] > 0 ? (tf(series[i]) - mean(h)) / s : null;
  };
  const retVol = [];
  for (let i = 0; i < n; i++) {
    sig.lpm20[i] = flowZ(lpm, i, CHANGE_DAYS);
    sig.lpm60[i] = flowZ(lpm, i, 60);
    sig.ff20[i] = flowZ(flow, i, CHANGE_DAYS);
    sig.vr[i] = levelZ(vr, i);
    sig.intensity[i] = levelZ(it, i, Math.log);
    sig.mom20[i] = i >= 20 ? adj[i] / adj[i - 20] - 1 : null;
    sig.mom60[i] = i >= 60 ? adj[i] / adj[i - 60] - 1 : null;
    sig.rev5[i] = i >= 5 ? -(adj[i] / adj[i - 5] - 1) : null;
    retVol[i] = i > 0 ? Math.log(adj[i] / adj[i - 1]) : 0;
    // divergence: LPM accumulation not yet in the price (both in volatility units)
    if (sig.lpm20[i] != null && i >= VOL_WINDOW) {
      const s = sd(retVol.slice(i - VOL_WINDOW + 1, i + 1));
      sig.div[i] = s > 0 ? sig.lpm20[i] - Math.log(adj[i] / adj[i - 20]) / (s * Math.sqrt(20)) : null;
    } else sig.div[i] = null;
  }
  stocks[c] = { dates, idx: Object.fromEntries(dates.map((d, i) => [d, i])), adj, close, value, sig };
}

// ── evaluation ────────────────────────────────
const rank = a => { const o = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2; i = j + 1; } return r; };
const pearson = (a, b) => { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return s / Math.sqrt(sa * sb); };
const spearman = (a, b) => pearson(rank(a), rank(b));

const calendar = [...new Set(Object.values(stocks).flatMap(s => s.dates))].sort();
const SIGNALS = {
  'LPM 20d': ['lpm20'], 'LPM 60d': ['lpm60'], 'LPM divergence': ['div'], 'Foreign flow 20d': ['ff20'],
  'Volume rotation': ['vr'], 'Intensity': ['intensity'], 'Momentum 20d': ['mom20'], 'Momentum 60d': ['mom60'], 'Reversal 5d': ['rev5'],
  'LPM + foreign flow': ['lpm20', 'ff20'], 'LPM + foreign + momentum 60d': ['lpm20', 'ff20', 'mom60'],
  'LPM div + foreign flow': ['div', 'ff20'],
  // LPM as a filter, not a rank: the strongest 60-day movers among stocks whose
  // LPM rose over the last 20 sessions, against the whole universe.
  'Momentum 60d, LPM rising only': { parts: ['mom60'], require: 'lpm20' },
};

function crossSection(date, parts, h, require = null) {
  const rows = [];
  for (const [c, s] of Object.entries(stocks)) {
    const i = s.idx[date];
    if (i == null || i + 1 + h >= s.dates.length || i < 20) continue;
    if (s.close[i] < MIN_PRICE) continue;
    const vals = s.value.slice(i - 19, i + 1).sort((a, b) => a - b);
    if (vals[10] < MIN_VALUE) continue;
    const x = parts.map(p => s.sig[p][i]);
    if (x.some(v => v == null || !Number.isFinite(v))) continue;
    const pass = require ? s.sig[require][i] != null && s.sig[require][i] > 0 : true;
    rows.push({ c, x, pass, fwd: s.adj[i + 1 + h] / s.adj[i + 1] - 1 });
  }
  if (rows.length < MIN_STOCKS) return null;
  // combine parts: average of cross-sectional ranks (scaled 0..1)
  const ranks = parts.map((_, k) => rank(rows.map(r => r.x[k])).map(v => v / (rows.length - 1)));
  rows.forEach((r, j) => { r.score = mean(ranks.map(rk => rk[j])); });
  return rows;
}

function evaluate(spec, h, from, to) {
  const parts = Array.isArray(spec) ? spec : spec.parts, require = Array.isArray(spec) ? null : spec.require;
  const dates = calendar.filter(d => d >= from && d <= to);
  const ics = [], excess = [], costs = [];
  let prevTop = null;
  for (let t = 0; t < dates.length; t += h) {
    const rows = crossSection(dates[t], parts, h, require);
    if (!rows) continue;
    const eligible = rows.filter(r => r.pass);
    if (eligible.length < 10) continue;
    ics.push(spearman(eligible.map(r => r.score), eligible.map(r => r.fwd)));
    const sorted = [...eligible].sort((a, b) => b.score - a.score);
    const top = sorted.slice(0, Math.max(1, Math.floor(rows.length / 5)));
    const topRet = mean(top.map(r => r.fwd)), all = mean(rows.map(r => r.fwd));
    const names = new Set(top.map(r => r.c));
    const changed = prevTop ? top.filter(r => !prevTop.has(r.c)).length / top.length : 1;
    costs.push(changed * (BUY_COST + SELL_COST));
    excess.push(topRet - all);
    prevTop = names;
  }
  if (ics.length < 8) return null;
  const perYear = 245 / h;
  return {
    n: ics.length, ic: mean(ics), icT: mean(ics) / sd(ics) * Math.sqrt(ics.length), hit: ics.filter(x => x > 0).length / ics.length,
    exGross: mean(excess) * perYear, exNet: (mean(excess) - mean(costs)) * perYear, exT: mean(excess) / sd(excess) * Math.sqrt(excess.length),
  };
}

// ── report ────────────────────────────────────
const pct = x => (x >= 0 ? '+' : '') + (100 * x).toFixed(1) + '%';
const lines = [];
const say = s => { console.log(s); lines.push(s); };
say(`# LPM backtest — ${new Date().toISOString().slice(0, 10)}`);
say('');
say(`Universe: ${Object.keys(stocks).length} stocks with Bandar Metrics series and Yahoo prices; liquidity filter median 20-day value ≥ Rp 1bn, close ≥ Rp 50.`);
say('IC = mean Spearman correlation between signal and next-h-session return (t-stat in brackets; |t| ≳ 2 is the usual bar).');
say('Top 1/5 vs all = annualised return of the top-ranked fifth minus the universe average, before and after trading costs.');
for (const h of HORIZONS) {
  say('');
  say(`## Holding ${h} sessions`);
  for (const [from, to, label] of PERIODS) {
    say('');
    say(`### ${label}`);
    say('');
    say('| Signal | Dates | IC (t) | IC > 0 | Top 1/5 vs all, gross | net of costs |');
    say('|---|---:|---:|---:|---:|---:|');
    for (const [name, parts] of Object.entries(SIGNALS)) {
      const r = evaluate(parts, h, from, to);
      if (!r) { say(`| ${name} | – | – | – | – | – |`); continue; }
      say(`| ${name} | ${r.n} | ${r.ic.toFixed(3)} (${r.icT.toFixed(1)}) | ${(100 * r.hit).toFixed(0)}% | ${pct(r.exGross)} (t ${r.exT.toFixed(1)}) | ${pct(r.exNet)} |`);
    }
  }
}
writeFileSync(new URL('lpm-backtest-results.md', import.meta.url), lines.join('\n') + '\n');
console.error('\nwritten research/lpm-backtest-results.md');
