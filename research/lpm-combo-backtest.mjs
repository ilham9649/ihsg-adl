// ──────────────────────────────────────────────
// LPM + Intensity + Volume Rotation, read together the way Bandar Metrics says
// to read them — an event study.
// ──────────────────────────────────────────────
// Usage:
//   node research/lpm-combo-backtest.mjs <bm_indicators.json> [--refresh-prices]
// Same input and price cache as research/lpm-backtest.mjs.
//
// Why a second backtest: lpm-backtest.mjs ranked Intensity and Volume Rotation
// "high = buy" on their own. Bandar Metrics says neither has a direction:
// LPM gives the direction, Intensity the timing ("LPM naik dan Intensity spike"
// is the combination they watch), Volume Rotation the quality (green = efficient
// one-way transfer, red = churn near a peak). Sources: bandarmetrics.com/kamus/
// lpm, /intensity, /volume-rotation (read 2026-11-14).
//
// Rules fixed BEFORE seeing any result — do not tune them to the output:
//   LPM rising      20-session LPM change ≥ +1σ of its own daily changes
//   LPM falling     20-session LPM change ≤ −1σ
//   price flat/down 20-session log return ≤ +0.5σ of its own daily returns
//                   (BM: rising LPM with flat price = accumulation)
//   spike           Intensity (log) ≥ 2σ above its own trailing 250 sessions,
//                   on any of the last 20 sessions
//   green rotation  mean Volume Rotation over the last 5 sessions in the lowest
//                   third of its own trailing 250 daily values. BM publishes no
//                   colour cut-offs; the lowest third is ours.
//   long rally      120-session log return ≥ +2σ
// Each setup is an event the first day it holds; the same stock can't fire the
// same setup again until the holding period has passed. Entry at the next
// close, held 20 sessions (main) and 60 (secondary); the event's return minus
// the equal-weight return of the liquid universe over the same window, less
// 0.4% round-trip costs. Events cluster in time, so the t-stat is over
// calendar months of entry (mean excess per month), not over events.
//
// Known biases: survivors only (~170 liquid stocks listed today); LPM before
// ~2023 comes from Bandar Metrics' older broker feed.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const [, , inputPath, ...flags] = process.argv;
if (!inputPath) { console.error('usage: node research/lpm-combo-backtest.mjs <bm_indicators.json> [--refresh-prices]'); process.exit(1); }
const DATA_DIR = new URL('./data/', import.meta.url);
mkdirSync(DATA_DIR, { recursive: true });

const HORIZONS = [20, 60];
const WINDOW = 250, MIN_HISTORY = 120, CHANGE_DAYS = 20;
const COST = 0.0015 + 0.0025;
const MIN_VALUE = 1e9, MIN_PRICE = 50;
const PERIODS = [
  ['2021-01-01', '2022-12-31', '2021–22 (older BM broker feed)'],
  ['2023-01-01', '2024-12-31', '2023–24'],
  ['2025-01-01', '2026-12-31', '2025–26'],
  ['2021-01-01', '2026-12-31', 'All, 2021–26'],
];

// ── data (as lpm-backtest.mjs) ────────────────
const bm = JSON.parse(readFileSync(inputPath, 'utf8'));
const codes = Object.keys(bm).filter(c => bm[c].lpm?.length > MIN_HISTORY);
const yymmdd = s => `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;

const priceFile = new URL('prices.json', DATA_DIR);
const prices = existsSync(priceFile) && !flags.includes('--refresh-prices') ? JSON.parse(readFileSync(priceFile, 'utf8')) : {};
const missing = codes.filter(c => !prices[c]);
if (missing.length) {
  const { fetchChart } = await import('../backend/scrapers/yahoo.js');
  for (let i = 0; i < missing.length; i += 6) {
    await Promise.all(missing.slice(i, i + 6).map(async c => {
      try { prices[c] = (await fetchChart(`${c}.JK`, 2600)).map(q => [q.date, q.adjClose, q.close, q.volume]); }
      catch (e) { console.error(`price ${c}: ${e.message}`); prices[c] = []; }
    }));
    await new Promise(r => setTimeout(r, 1500));
  }
  writeFileSync(priceFile, JSON.stringify(prices));
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ── per-stock signals ─────────────────────────
const stocks = {};
for (const c of codes) {
  const px = prices[c] || [];
  if (px.length < MIN_HISTORY) continue;
  const get = name => new Map((bm[c][name] || []).map(([d, v]) => [yymmdd(d), v]));
  const L = get('lpm'), V = get('volume_rotation'), I = get('intensity');
  const dates = px.map(p => p[0]), adj = px.map(p => p[1]), close = px.map(p => p[2]);
  const value = px.map(p => p[2] * p[3]);
  const n = dates.length;
  let last = null;
  const lpm = dates.map(d => { const v = L.get(d); if (v != null) last = v; return last; });
  const vr = dates.map(d => V.get(d) ?? null), it = dates.map(d => { const v = I.get(d); return v > 0 ? Math.log(v) : null; });
  const lr = dates.map((_, i) => i > 0 && adj[i] > 0 && adj[i - 1] > 0 ? Math.log(adj[i] / adj[i - 1]) : null);

  // a change over `days` in units of the series' own daily-change σ
  const changeZ = (series, i, days, isReturn = false) => {
    if (i < MIN_HISTORY || i < days) return null;
    const ch = [];
    for (let j = Math.max(1, i - WINDOW + 1); j <= i; j++) {
      const d = isReturn ? series[j] : (series[j] != null && series[j - 1] != null ? series[j] - series[j - 1] : null);
      if (d != null) ch.push(d);
    }
    if (ch.length <= 60) return null;
    const s = sd(ch);
    if (!(s > 0)) return null;
    if (isReturn) return adj[i] > 0 && adj[i - days] > 0 ? Math.log(adj[i] / adj[i - days]) / (s * Math.sqrt(days)) : null;
    return series[i] != null && series[i - days] != null ? (series[i] - series[i - days]) / (s * Math.sqrt(days)) : null;
  };
  const levelZ = (series, i) => {
    if (i < MIN_HISTORY || series[i] == null) return null;
    const h = [];
    for (let j = Math.max(0, i - WINDOW + 1); j <= i; j++) if (series[j] != null) h.push(series[j]);
    if (h.length <= 60) return null;
    const s = sd(h);
    return s > 0 ? (series[i] - mean(h)) / s : null;
  };

  const lpm20 = [], px20 = [], px120 = [], itZ = [], green = [];
  for (let i = 0; i < n; i++) {
    lpm20[i] = changeZ(lpm, i, CHANGE_DAYS);
    px20[i] = changeZ(lr, i, CHANGE_DAYS, true);
    px120[i] = changeZ(lr, i, 120, true);
    itZ[i] = levelZ(it, i);
    // green: 5-session mean rotation in the lowest third of its trailing 250 daily values
    if (i >= MIN_HISTORY) {
      const recent = vr.slice(i - 4, i + 1).filter(v => v != null);
      const hist = vr.slice(Math.max(0, i - WINDOW + 1), i + 1).filter(v => v != null);
      green[i] = recent.length >= 3 && hist.length > 60 ? hist.filter(v => v < mean(recent)).length / hist.length <= 1 / 3 : null;
    } else green[i] = null;
  }
  const spike = itZ.map((_, i) => {
    const w = itZ.slice(Math.max(0, i - CHANGE_DAYS + 1), i + 1).filter(v => v != null);
    return w.length >= 10 ? w.some(v => v >= 2) : null;
  });
  const liquid = dates.map((_, i) => {
    if (i < 19 || close[i] < MIN_PRICE) return false;
    return median(value.slice(i - 19, i + 1)) >= MIN_VALUE;
  });
  stocks[c] = { dates, idx: Object.fromEntries(dates.map((d, i) => [d, i])), adj, lpm20, px20, px120, spike, green, liquid };
}

// ── setups ────────────────────────────────────
const up = (s, i) => s.lpm20[i] != null && s.lpm20[i] >= 1;
const down = (s, i) => s.lpm20[i] != null && s.lpm20[i] <= -1;
const flat = (s, i) => s.px20[i] != null && s.px20[i] <= 0.5;
const SETUPS = {
  'LPM rising, price flat/down': (s, i) => up(s, i) && flat(s, i),
  'Intensity spike (any LPM)': (s, i) => s.spike[i] === true,
  '**LPM rising + spike, price flat/down**': (s, i) => up(s, i) && flat(s, i) && s.spike[i] === true,
  '**… + rotation green**': (s, i) => up(s, i) && flat(s, i) && s.spike[i] === true && s.green[i] === true,
  '… + rotation not green': (s, i) => up(s, i) && flat(s, i) && s.spike[i] === true && s.green[i] === false,
  'Spike while LPM falling (BM: unloading)': (s, i) => down(s, i) && s.spike[i] === true,
  'LPM rising after a long rally (BM: question it)': (s, i) => up(s, i) && s.px120[i] != null && s.px120[i] >= 2,
};

// equal-weight forward return of the liquid universe, by entry date and horizon
const calendar = [...new Set(Object.values(stocks).flatMap(s => s.dates))].sort();
const universe = {};
for (const h of HORIZONS) {
  universe[h] = {};
  for (const d of calendar) {
    const r = [];
    for (const s of Object.values(stocks)) {
      const i = s.idx[d];
      if (i != null && s.liquid[i] && i + 1 + h < s.dates.length) r.push(s.adj[i + 1 + h] / s.adj[i + 1] - 1);
    }
    if (r.length >= 30) universe[h][d] = mean(r);
  }
}

function events(test, h) {
  const out = [];
  for (const [c, s] of Object.entries(stocks)) {
    let blockedUntil = -1, prev = false;
    for (let i = 0; i + 1 + h < s.dates.length; i++) {
      const on = s.liquid[i] && test(s, i);
      if (on && !prev && i > blockedUntil && universe[h][s.dates[i]] != null) {
        const ret = s.adj[i + 1 + h] / s.adj[i + 1] - 1;
        out.push({ c, date: s.dates[i], excess: ret - universe[h][s.dates[i]] - COST });
        blockedUntil = i + h;
      }
      prev = on;
    }
  }
  return out;
}

const pct = x => (x >= 0 ? '+' : '') + (100 * x).toFixed(1) + '%';
const lines = [];
const say = s => { console.log(s); lines.push(s); };
say(`# LPM + Intensity + Volume Rotation, combined — ${new Date().toISOString().slice(0, 10)}`);
say('');
say(`Event study, ${Object.keys(stocks).length} stocks. Rules in research/lpm-combo-backtest.mjs, fixed before the run.`);
say('Excess = the stock\'s return from the next close over h sessions minus the liquid universe\'s equal-weight return, less 0.4% costs.');
say('t is over calendar months of entry (events in the same month are not independent). |t| ≳ 2 is the usual bar; under ~30 events, read nothing into it.');
for (const h of HORIZONS) {
  say('');
  say(`## Holding ${h} sessions${h === 20 ? ' (main test)' : ''}`);
  for (const [from, to, label] of PERIODS) {
    say('');
    say(`### ${label}`);
    say('');
    say('| Setup | Events | Mean excess | Median | Beat universe | t (months) |');
    say('|---|---:|---:|---:|---:|---:|');
    for (const [name, test] of Object.entries(SETUPS)) {
      const ev = events(test, h).filter(e => e.date >= from && e.date <= to);
      if (ev.length < 5) { say(`| ${name} | ${ev.length} | – | – | – | – |`); continue; }
      const byMonth = {};
      for (const e of ev) (byMonth[e.date.slice(0, 7)] ||= []).push(e.excess);
      const m = Object.values(byMonth).map(mean);
      const t = m.length > 2 && sd(m) > 0 ? mean(m) / sd(m) * Math.sqrt(m.length) : NaN;
      const x = ev.map(e => e.excess);
      say(`| ${name} | ${ev.length} | ${pct(mean(x))} | ${pct(median(x))} | ${(100 * x.filter(v => v > 0).length / x.length).toFixed(0)}% | ${Number.isFinite(t) ? t.toFixed(1) : '–'} |`);
    }
  }
}
writeFileSync(new URL('lpm-combo-backtest-results.md', import.meta.url), lines.join('\n') + '\n');
console.error('\nwritten research/lpm-combo-backtest-results.md');
