# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Serverless IHSG (Jakarta Composite Index) market dashboard — **"The Jakarta Ledger"** (editorial broadsheet UI). Four pages: `index.html` (breadth & momentum), `valuation.html` (intrinsic value, cheapest to dearest — see *Valuation page* below), `sentiment.html` (LLM-scored daily market sentiment — see *Sentiment page* below), and `ma200w.html` (proximity to each stock's 200-week moving average — see *200-Week Trend Line page* below). Tracks the **full IDX listing (~957 stocks, all boards)** daily. The backend computes per-day breadth metrics (**% Advancing**, spread, A/D ratio, McClellan, `adLine`) and stores the IHSG index OHLC; the frontend adds index-price and momentum views. Panels: IHSG candles (with a per-session **"Who Moved It"** attribution beneath — see *Index movers* below), the % Advancing breadth line (20/100/200-day MA ribbon), the Zweig Breadth Thrust, weekly Stochastic, and the Shinohara Intensity Ratio. (The A/D Ratio and McClellan *chart panels* were removed from the UI; those values are still computed and shown in the top indicator strip.)

> **Headline breadth = % Advancing, NOT the cumulative A/D Line.** A raw cumulative A/D Line (running sum of advances−declines) is not a mean-reverting oscillator: over 2023–2026 it drifts down ~1.5k on the liquid set and ~16k on the broad ~500 universe, because Indonesia's equal-weight breadth was persistently negative while the cap-weighted IHSG was held up by a few mega-caps. This is **genuine breadth, not a computation bug** — verified: switching raw→adjusted close removes only ~5–11% of the drift, and a volume/forward-fill filter removes ~0%. So the dashboard leads with `pctAdvancing` = advances/(advances+declines)×100, which oscillates around 50%. `adLine` is still computed and stored as a raw datum (and its cumulative invariant is unit-tested) but is not charted. See `computeSeries` in `backend/scrapers/yahoo.js`.

**Live:** [finance.sulaksono.id](https://finance.sulaksono.id)

## Architecture

```
S3 + CloudFront (frontend) → API Gateway v2 (HTTP API) → Lambda (Node.js)
                                                              ↓
                                                         DynamoDB
                                                              ↑
EventBridge (cron 17:00 WIB) → Lambda (scraper) → Yahoo Finance API
```

Infrastructure is managed in a separate repo: `ilham9649/infrastructure` (`terraform/finance-adl/`)

## Development Commands

### Backend (Lambda)
```bash
cd backend
npm ci                    # Install dependencies
npm test                  # Run unit tests
```

### Frontend (Static files)
No build step — vanilla JS served directly to S3. Edit and deploy.

### Package Lambda for deployment
```bash
npm run zip              # Creates function.zip at repo root
npm test                 # Run unit tests (from root)
```

Or manually:
```bash
cd backend && npm ci && zip -r ../function.zip .
```

## Key Implementation Details

### API Handler Dual Format Support
The Lambda handler (`backend/index.js`) supports both REST API v1 and HTTP API v2 event formats:
- `getMethod(event)` — extracts HTTP method from `event.requestContext.http.method` (v2) or `event.httpMethod` (v1)
- `getPath(event)` — extracts path from `event.rawPath` (v2) or `event.path` (v1), strips stage prefix for v1
- Response handling accounts for double-wrapped body in v1 format (`json.body` + `json.statusCode`)

Frontend (`frontend/app.js`) handles both formats when parsing API responses.

### Delisted Companies (survivorship bias)
`IDX_TICKERS` is a snapshot of who is listed **today**, so on its own the history is survivors-only — every firm that died is invisible on all past dates, biasing historical `% Advancing` upward (failing companies fall hard before they exit). `DELISTED_TICKERS` in `tickers.js` closes that gap; `getAllTickers()` returns both.

**Yahoo serves full history for a delisted `.JK` symbol** right up to its last trading day (verified: all 10 of the 2025-07-21 delistings return complete bars back to 2009). So a delisted name costs nothing but its ticker code, and needs no special handling downstream — it simply has no bars after its exit, and the per-day fold only counts a ticker on dates it actually traded.

The list is **incomplete** (2025 only; IDX delisted ~60–70 companies over 2010–2026). To extend it, drive `idx.co.id` → Market Data → Statistical Reports → Delisted Company **in a browser** (server-side fetches get 403, same as the main list), then verify with `node backend/audit-delisted.js` — it flags codes Yahoo never indexed (FINN, delisted 2021, returns nothing), duplicates, and long mid-series halts that could mean IDX reassigned the code. Note the 18 companies delisting 2026-11-10 are still in `IDX_TICKERS`; move them across after they go.

> **`isStaleComparison` (`yahoo.js`)** skips the one price comparison that spans a gap of >30 days. A stock resuming from suspension often reopens ±70%, and a reassigned ticker code would compare one company's close to another's — both are noise, not breadth. IDX's watchlist board halts names for months, so this fires on real data (e.g. KRAH, halted 124 days from 2016-10-20).

### Ticker Universe
`backend/lib/tickers.js` hardcodes the **complete IDX securities list (~957 tickers, all boards: Main/Development/Acceleration/Watchlist)**, scraped from the IDX official API (`idx.co.id` `GetSecuritiesStock`). It's hardcoded because IDX's API blocks server-side fetches (Cloudflare/403) and stockanalysis.com's free list caps at 500 — so live discovery from Lambda isn't possible. **Re-scrape periodically** to pick up new IPOs (drive `idx.co.id/en/market-data/stocks-data/stock-list` in a browser and fetch its API in-page). Many small/suspended names have no usable Yahoo data — `fetchQuotes` returns `[]` for those and they're excluded from the daily counts (~750-850 of 957 typically usable). All tickers suffixed `.JK`.

> **Refresh scale & API Gateway 29s limit:** a ~967-ticker × 16-year scrape (`DAYS_BACK = 6100`, history to ~2010) takes ~5 minutes — measured ~300s, against the 900s Lambda cap (batches of 6, 1.5s apart; daily counts folded incrementally to bound memory). The scheduled EventBridge run invokes the Lambda directly, bounded only by the Lambda timeout (900s — keep it there). The manual `POST /api/ad/refresh` **Refresh** button goes through API Gateway (~29s cap) so it returns 504 even though the Lambda keeps running and still writes the data. Treat the daily cron as the source of truth; big repopulations can be run locally against the prod table.

### Yahoo Finance Scraper
Uses Yahoo Finance v8 chart API directly (`/v8/finance/chart/{ticker}`) — no external library dependency. Rate limited by:
- Processing in batches of 6 tickers in parallel
- 1.5-second delay between batches
- Processes ~957 tickers in ~5-8 minutes (no-data micro-caps 404 fast, so failures don't slow it much)

### DynamoDB Pattern
Table: `ihsg-adl` (or `TABLE_NAME` env var). Primary key is `date` (string S). Stores aggregated daily metrics, not per-ticker data. `BatchWriteItem` chunks at 25 items max.

### Frontend Indicators (computed client-side, `frontend/app.js`)
Everything the frontend charts is **derived in the browser** from what the API already returns (daily breadth counts + IHSG OHLC) — there are **no dedicated backend/DB fields** for these, so tuning them needs only a frontend deploy (no re-refresh):
**All five panels are `BreadthChart`** (`frontend/breadth-chart.js`, dependency-free canvas) so they share one visual language. Panel configuration lives in one place — `PANEL_SPECS` in `app.js`. Chart.js was removed; do not reintroduce a charting library for a new panel, extend `BreadthChart` instead. Its `series` panel supports `field`/`rawField`/`overlays`/`ref`/`yMin`/`yMax`/`zones`/`markField`/`tipAd`.

> **Series fill/stroke colour splits at `ref`**, not by the last value: green above the neutral line, red below. A series that crosses its reference (the breadth line through 50, the Shinohara spread through 0) must not read as one colour throughout.

- **% Advancing MA ribbon** — `attachPctSmoothing` computes 20/100/200-day SMAs of `pctAdvancing` over the full series (`pctAdvancingMA`/`...MA100`/`...MA200`). Drawn as a ribbon with a toggle checklist, a faint daily dot-cloud (raw `pctAdvancing`), and the 50% neutral line.
- **Zweig Breadth Thrust** — `attachThrust` computes a 10-day EMA of `pctAdvancing` (`zbt`) and flags two rules from `THRUST_RULES`, both "≤40 → ≥high within 10 sessions": Zweig's canonical `thrust` (61.5) and the Jakarta rule `idxThrust` (56). The chart's ▲ marks are `idxThrust`. All counts and returns in the panel copy are computed live, never hardcoded.
  - **Zweig's 61.5 is not a US-only bar.** On the full 2010–2026 history, it fired once (2011-10), and 61.5 sits at the 99.7th percentile of the IDX EMA, about as rare as on the NYSE.
  - **56 is a watch level, not a proven signal.** Backtest (2010-01 → 2026-09, episodes = triggers ≥63 sessions apart): 7 episodes (2010-06, 2011-07, 2011-10, 2012-06, 2015-10, 2025-04, 2026-06); IHSG +14.7% avg 6 months later vs +2–8% base. But neighbours are much weaker (55 → +10.5%, 57 → +6.5%), 4 of 7 episodes predate 2014 (thin market, high base returns), and only 2 post-2014 episodes have 6 months of history. Keep the panel copy honest about this; do not tune the threshold further to chase returns.
  - **SPY comparison in the copy is hardcoded** (the one exception to "computed live"): Yahoo no longer serves NYSE advance/decline data, so US signals can't be computed. Figures: SPY price return 126 sessions after US ZBT triggers 2009-03-23~, 2011-10-12~, 2015-10-07~, 2019-01-10, 2023-11-03, 2025-04-24 (~ = approximate day, from published articles) → avg +17.3% vs +6.3% any-day base (2010–2026). SPY after the *Jakarta* dates is only +8.4%, so the Jakarta lift is local, not a global rally.
- **Stochastic (15,3,3)** — `attachStochastic` aggregates IHSG OHLC to **weekly** bars → `stochK`/`stochD`.
- **Shinohara Intensity Ratio (26)** — `attachShinohara` uses **Yahoo's exact ChartIQ formula** so the numbers match Yahoo Finance's display: `Strong = 100·Σ(High−prevClose)/Σ(prevClose−Low)`, `Weak = 100·Σ(High−Close)/Σ(Close−Low)` over 26 **weekly** bars (`shinStrong`/`shinWeak`). ⚠️ The textbook Shinohara / AR-BR uses High−**Open** and does NOT match Yahoo — don't "correct" it to that. The panel charts the `shinSpread` (`Weak − Strong`) directly, since the gap *is* the reading; >100 = "extremely oversold" and is shaded.
- **Cross-chart hover sync** (`HoverSync`) — hovering any panel highlights the same date on all of them (all panels share the filtered-data index).
- **Reading period** — `getFilteredData` slices `allData` by trailing row count, plus a special `ytd` value (filter from Jan 1 of the current year).

### Index movers — "Who Moved It" (Fig. I, `backend/scrapers/movers.js`)
Under the IHSG candles: for any session, which constituents moved the index and by how many **index points**. It follows the `HoverSync` hover and stays on the last session hovered (‹ › step session by session; touch has no hover). The one front-page figure **not** computed in the browser — it needs share counts and free floats — so it comes from `GET /api/movers`, fetched separately so the page never waits on it; the block stays hidden if that fails.

`points = IHSG(prev close) × weight(prev close) × stock return(today)`, where weight is free-float market cap (`shares × float × price`), **capped at 9%** with the excess redistributed (`capWeights`), and **HSC stocks excluded** from their effective date. Raw close, not `adjClose` — the IHSG is a price index and really falls when a heavyweight goes ex-dividend (Yahoo's raw close is still split-adjusted, which is right). A halted stock keeps its last close for up to 30 days (in the weights, moving nothing), same gap as `isStaleComparison`.

> **Free float is not optional — IHSG is float-weighted.** IDX's own numbers say so: HSC stocks are ~30% of market cap but ~18% of index weight, and BBCA rises to a 9% cap when they leave. Measured over 2025-10 → 2026-10 (252 sessions), rebuilding the real daily point move: **full market cap missed by 14 pts on average** (mean move 82) and told the wrong story on the days that matter — 2026-05-29 the IHSG fell 2.8 pts, and full cap had BREN lifting it +53 (an estimated +63 day). Float weights: 7.0 pts; with the two float corrections below, **4.7 pts** (worst 27.7), and no session over 10 pts with the wrong sign. Don't "simplify" to full market cap.

Inputs, all dated so a past session is weighted the way it actually was:
- **Share counts** — Yahoo `fundamentals-timeseries` `OrdinarySharesNumber` (annual + quarterly), via `fetchShareCounts` in `valuation.js`. Fetched in the daily breadth loop, one extra small call per ticker in parallel with its chart — measured **+3s** on the full run (the 1.5s batch delay dominates). `sharesOn` picks the filing in force on each date: dated counts beat the latest count applied to every date (4.7 vs 6.1 pts, worst day 28 vs 127 — GIAA's 13× share issuance). ⚠️ Known gap: filed counts aren't split-adjusted while Yahoo's closes are, so a stock that splits is under-weighted by the split ratio until its next filing (only BUAH, 2:1 on 2025-10-22, in 2025-10 → 2026-10). The fix, if a heavyweight ever splits: request `events=split` on the chart call and scale each filing by the splits after its date.
- **Free floats** — dated **snapshots**, from stockanalysis.com's per-stock Float / Shares Outstanding (Yahoo's float is behind 401 quoteSummary; IDX's free-float report is behind Cloudflare, even for headless Chromium). The **monthly `freefloat` job** (`scrapers/freefloat.js`, `refreshFreeFloat` in `index.js`; EventBridge `ihsg-adl-freefloat-refresh`, 2nd of the month 12:00 UTC, or `POST /api/freefloat/refresh` — ~6 min, so that route 504s at API Gateway's 29s while the Lambda finishes) stores one `ff#YYYY-MM-DD` item per run, kept forever. `lib/freefloat.js` is the **frozen baseline** (2026-10-29, 861 of 957 codes): the oldest snapshot, and the whole story until a job run lands. `computeMovers` takes every snapshot and gives each session, per code, the latest one on or before it (earliest if none) — so a partial snapshot drops nobody; codes in no snapshot take the newest one's median. A run where under 60% of codes answer (`MIN_COVERAGE` — markup change, or the site turning away the Lambda's datacenter IP) is **not stored**: the estimate keeps the older figures instead of quietly losing most of the listing. Floats that changed between snapshots are wrong until the next one, by up to a month.
- **Hand-maintained rules** — `lib/ihsg-rules.js`: `HSC_SCHEDULE` (81 codes out of the index from 2026-11-02; IDX reviews it **quarterly**, effective the first trading day of Feb/May/Aug/Nov — add a new dated entry, don't edit the old one) and `FLOAT_OVERRIDES` (dated corrections that win over the snapshots). The overrides came from regressing each session's miss on each heavyweight's estimated points: TPIA came out ×2.2 too heavy (t=13 — its float was 10.9% until SCG's 2026-06-08 sell-down, 25.7% after) and BRMS ×3.2 too light (t=−8.5 — KSEI-based float ~51%, table had 17.5%). **Add an override only with a published source; never tune a number to shrink the miss.** EMAS still shows a weaker signal (t≈−3.9) with no source found — left alone.

**Storage:** one item `_movers` (like `_valuation`), the trailing 252 sessions recomputed in full on every breadth refresh, ~130KB of DynamoDB's 400KB — a much longer window needs one item per day. Each session stores the real `change`/`pct`, the `estimate` its weights add up to, the top 5 `up`/`down` (`{ticker, pts, pct}`), `rest` (net of everyone else) and `counted`; the page prints the estimate beside the real move so the gap is never hidden. Wrapped in try/catch in `refreshData`: a movers failure is logged, not allowed to fail a breadth refresh that's already written.

**Upkeep:** add each quarterly HSC review to `HSC_SCHEDULE`; check the `freefloat` job's CloudWatch line each month (`Free floats complete` vs `snapshot not stored`); re-check the residual regression after a new HSC list or a large float change. A float override wins over every snapshot — to hand a code back to the snapshots once they're right, end its override with a `{ from, ratio: null }` step.

### Valuation page (`frontend/valuation.html`)
A **second page** — "The Valuation Column" — ranking the IDX listing cheapest to dearest by estimated intrinsic value. Unlike every indicator on the front page, this is **not** computed client-side: the frontend only filters and renders what `GET /api/valuation` returns.

**Two models, because one does not fit both kinds of business** (`backend/scrapers/valuation.js`):
- **Operating companies → two-stage DCF.** 5 years of FCF grown at the company's revenue CAGR (clamped 0–15%), Gordon terminal value, discounted at 13%. Equity = EV − debt + cash.
- **Financials → residual income (excess return).** ⚠️ **Never run a FCF-DCF on a bank.** Yahoo reports 75T "free cash flow" for BBCA — that is deposit and lending flow, i.e. the balance sheet, not owner earnings, and a DCF reads it as enormous wealth. The excess-return model values a bank as `book value + PV[(ROE − Ke) × book]`, so a bank earning exactly its cost of equity is worth exactly book. Growth is the sustainable rate `ROE × (1 − payout)`, capped below the discount rate or the terminal value goes infinite/negative. Routed by `isFinancial()` on the Yahoo `sector` field.

Both return a per-share number, so the two sets rank in one list.

> **DDM is a cross-check table, not a third routing bucket.** `ddmPerShare` runs a two-stage dividend discount model — same growth/discount assumptions as the DCF (shares `presentValueOfGrowingFlow`), built on `annualCashDividendsPaid`/`quarterlyCashDividendsPaid` (already in `FIELDS`, no new Yahoo call) instead of free cash flow. It runs for every company regardless of `isFinancial()` — unlike the primary model, valuing what a company pays out doesn't depend on what kind of business it is — and returns `null` for the roughly half of the universe with no reliable dividend. Converted through the same `fxRate` as the primary model. `frontend/valuation.js` surfaces it as **Table B** ("What It Pays, Against What It's Worth"), not an extra column on the primary ranking (Table A) — an earlier version bolted it on as a column and it read as a third confusing figure crammed into one row. Table B only lists companies with a `ddmFairValue` and a positive primary `fairValue` (a negative primary value has nothing to divide the ratio against), sorted by the gap, widest first. The gap itself is deliberate signal: a company that generates more cash than it distributes (common among IDX's controlling-family firms) shows a DDM well below its main figure.

> **Currency: fundamentals aren't always IDR, even though every price is.** A handful of exporters (ADRO, ITMG, MEDC, PGEO, ...) file annual accounts in USD while trading in IDR on the IDX. `fetchFundamentals` captures the `currencyCode` Yahoo tags on every timeseries line; `valuateTicker` converts the resulting per-share fair value to IDR via a live `IDR=X` (USD/IDR) rate — fetched once per run and cached (`fxRateToIdr` in `valuation.js`), not once per ticker — before comparing it to the IDR price. Left unconverted this silently divides a USD-scale numerator by an IDR-scale price, landing the fair value ~15,000x too small — it doesn't error, it just reads as the company being worthless (this hit ~41 of ~390 valued companies before the fix, all USD filers, e.g. PGEO showed a fair value of Rp0.05 against a Rp1,065 price).

> **Data source: `ws/fundamentals-timeseries`, not `quoteSummary`.** The `v10/finance/quoteSummary` endpoint now returns **401** (needs a crumb + cookie). The fundamentals-timeseries endpoint serves annual FCF, revenue, debt, cash, net income, equity, dividends and share count with **no auth**. Sector/industry comes from `v1/finance/search` — also free. Do not "fix" this by reintroducing quoteSummary.

**Known limits — these are honest constraints, not bugs to patch:** Yahoo publishes only ~4 years of annuals (from ~2022), so growth rests on a short history; every name is discounted at a flat 13% (no per-name beta — four annual reports cannot support that precision); loss-making and non-filing companies get **no valuation** and are absent from the table rather than shown as cheap. The page states all of this in its method note. It ranks; it does not price.

**The spread figure** (`renderSpread` in `valuation.js`) is the page's signature: one hairline per company on a `log₂(fairValue / price)` axis, **left = cheap**, drawn as inline SVG (not `BreadthChart` — that panel is built for time series, and this is a 1-D distribution; no library was added). Log scale because the raw discount runs −1240%…+685% and collapses to a smear on a linear axis. The axis floor is `VOID_FLOOR = -6`; below that the estimate is under a sixtieth of the price, which is an artefact of rounding a near-zero fair value rather than a reading, so those join the **no-value block** past a broken-axis mark. That block is ~118 of 390 — the biggest single finding on the page, so it is deliberately the heaviest object in the figure. Hairlines are drawn at low opacity so crowding darkens the field on its own. Filtering the table dims non-matching hairlines rather than re-scaling the figure, which would make the hero jump while someone types.

> **Readout text is built from DOM nodes, never `innerHTML`.** `ticker`/`name` come straight from Yahoo. The table takes the same care for the same reason.

**Storage:** one DynamoDB item, `date = "_valuation"`, holding the whole ranking as a JSON string plus `attempted`. Read and written whole, never queried per ticker. `getAllData()` filters on `attribute_exists(advances)` so this row (and the refresh lock) can never reach the daily-series parser.

**Scheduling:** valuations move only when a company files, so this runs on its **own** trigger — `POST /api/valuation/refresh`, or an EventBridge event with `job: "valuation"`. It must **not** share the daily breadth cron: each ticker costs three Yahoo calls (~967 × 3), so the two jobs together would exceed the 900s Lambda timeout. Its EventBridge rule (`ihsg-adl-valuation-refresh`, nightly 11:00 UTC) lives in the infrastructure repo, `terraform/finance-adl/main.tf`, beside the others.

### Sentiment page (`frontend/sentiment.html`)
A **third page** — market-wide (not per-stock) daily sentiment, scored by an LLM from Indonesian financial news headlines. Score scale is **−100 (extremely bearish) to +100 (extremely bullish), 0 = neutral**.

**Pipeline** (`backend/scrapers/news.js` + `backend/scrapers/sentiment.js`): fetch **three** Indonesian financial RSS feeds in parallel — CNBC Indonesia's general "Market" section, Kontan's `investasi` feed (the most directly on-topic: ticker moves, IHSG levels, foreign net buy/sell), and Detik Finance — merge and dedupe by title (`mergeHeadlines`, sorted newest first), filter to today's WIB-calendar-day headlines (falling back to the most recent ~20 across all sources on a thin news day), and send them to DeepSeek's OpenAI-compatible chat-completions API via raw `fetch` (no SDK, matching this repo's zero-dependency scraper convention) with model `deepseek-chat` (overridable, see below). Each source fails independently — `Promise.allSettled` in `fetchHeadlines()` — so one outlet going down (CNBC 403'd the deployed Lambda once; see below) degrades the reading instead of killing it. The feeds mix genuine market news with unrelated stories (disasters, banking how-tos); the prompt itself does the filtering, not the scraper. A response that fails to parse is discarded rather than stored — a phantom reading in the time series is worse than a skipped day.

> **All three feeds needed a spoofed browser `User-Agent`** (matching `yahoo.js`) to work from the deployed Lambda — verified this the hard way: a plain local `curl` reached CNBC's feed fine with no UA at all, but the same request 403'd from the Lambda's AWS IP once deployed. Cloudflare-style bot-scoring rates datacenter IPs worse than residential ones for identical requests, so a source that works in local testing can still fail in prod — always verify a new source against the live `/api/sentiment/refresh` endpoint, not just a local curl. Bisnis.com and idx.co.id-style JS challenges (not just a UA check) can't be fetched server-side at all — skipped, not a bug to fix.

> **Requires `LLM_API_KEY`** in the Lambda environment — not provisioned by this repo (see *Environment Variables* below). Until it's set, `refreshSentiment()` fails cleanly (no key, no write).

**Storage:** one DynamoDB item **per day**, like the daily breadth rows, but under key `sent#YYYY-MM-DD` — a distinct prefix from the plain `date` key so it can never collide with, or be clobbered by, the breadth refresh's full-item overwrite for that same calendar day. `getAllSentiment()` scans on `begins_with(date, "sent#")`.

**Scheduling:** sentiment moves once a day off a few RSS fetches and one LLM call (seconds, not minutes), so like valuation it runs on its **own** trigger — `POST /api/sentiment/refresh`, or an EventBridge event with `job: "sentiment"`. Its EventBridge rule (`ihsg-adl-sentiment-refresh`, 15:00 UTC = 22:00 WIB) lives in the infrastructure repo like valuation's. Unlike valuation's ~500s job, this one is fast enough that the **Re-read** button on the page goes straight through API Gateway without hitting its 29s cap. The refresh route has no auth, and each call bills a real LLM request, so `acquireSentimentCooldown`/`releaseSentimentCooldown` in `lib/db.js` enforce a 5-minute cooldown between runs.

**Known limits — stated on the page itself:** it's one LLM's read of one day's headlines from a handful of news feeds, not a rigorous signal — the same headlines re-read, or read by a different model, would not always file the same number. **No historical backfill** — investigated pulling a year of history from the Wayback Machine's CDX index for these feed URLs, but CNBC's feed has only ~11 snapshots over the past year (roughly monthly), far too sparse for a "one point per trading day" series. The RSS feeds themselves only expose a rolling window, not a deep archive, either. So the trend line starts thin from first deploy and lengthens by one point a day going forward — there is no way to backfill it short of finding a genuinely different, actually-archival data source.

### 200-Week Trend Line page (`frontend/ma200w.html`)
A **fourth page** — market-wide proximity to each stock's own **200-week moving average** (a slow support/resistance line long-term holders watch — roughly the price averaged over the trailing ~3.8 years). Unlike Sentiment (its own LLM call) or Valuation (its own fetch job), this one **piggybacks entirely on the existing daily breadth scrape** — no new job, no new Yahoo calls, no new Lambda timeout budget to worry about.

**Computation** (`backend/scrapers/ma200w.js`, pure — no fetching): `refreshData()` in `index.js` already pulls `DAYS_BACK = 6100` days of daily bars per ticker to fold into breadth counts; for every ticker whose quotes survive that same batch loop, it now also calls `ma200wSnapshot(quotes)` before the quotes go out of scope. That function buckets the daily bars into ISO weeks — **the same convention as the frontend's weekly Stochastic/Shinohara panels** (`frontend/app.js`: `isoWeek`/`weeklyBars`): a week's close is whatever the latest available close is, including a still-forming current week, not only a "completed" one. It averages the trailing 200 weekly closes (adjusted close, same ex-dividend reasoning as breadth classification in `yahoo.js`) and returns `{ asOf, price, ma200w, pctFromMa }`, or `null` if the ticker has under 200 weekly buckets — a name listed less than ~3.8 years ago has no line to be near, and is omitted rather than estimated (the same honest gap Valuation leaves for companies its models can't value).

**Storage** (`backend/lib/db.js`) — two shapes for two different questions, each reusing a pattern already established by another page:
- *"How has the market read over time?"* → one small item **per day** (`ma200w#YYYY-MM-DD`, same prefix scheme as Sentiment's `sent#`), holding just `universeCount`/`pctNear`/`pctBelow` (from `summarizeMa200w`). Cheap enough to scan and keep forever.
- *"Which stocks are near their line today?"* → a **single** item (`_ma200w_latest`, same pattern as Valuation's `_valuation`), holding the full per-ticker table as JSON, overwritten on every refresh. There is no reason to pay to store (and re-scan) an ~850-row table every day when only the latest one is ever shown.

`pctNear` — the headline figure — is the share of the universe within ±5% of its own line either side, a support-testing analogue of `pctAdvancing`: it says how much of the market is sitting *at* a level that has mattered before, not which way the market is going.

**Backfill** (`backend/backfill-ma200w.js`, one-time local script): unlike Sentiment, price history has real depth, so a year of daily trend readings can be backfilled cheaply. Yahoo already serves each ticker's full history in one call, so the script fetches `DAYS_BACK = 2200` (~6 years — enough for the 200-week window plus the backfill year plus slack) **once per ticker**, then re-slices that same in-memory series at every trading day in the past year (using the IHSG index's own bars as the trading-day calendar) instead of one Yahoo call per ticker per day. Run it the same way as other big repopulations (see *Testing Locally* below).

**API:** `GET /api/ma200w` returns `{ trend, updatedAt, data }` — no dedicated refresh route, since this rides along with `POST /api/ad/refresh` (or the daily breadth cron) and there is nothing separate to trigger.

**Known limits — stated on the page itself:** proximity to a 200-week average has no fixed directional meaning by itself (it can be a level that holds or one that breaks straight through) — the page counts closeness, it does not predict which way it resolves. Recently listed stocks are excluded, not estimated, until they clear ~3.8 years of history.

### Deployment
Push to `main` triggers GitHub Actions:
1. Frontend: `aws s3 sync` to S3, CloudFront invalidation
2. Backend: `npm ci`, zip, `lambda update-function-code`

## Environment Variables

- `TABLE_NAME` — DynamoDB table name (default: `ihsg-adl`)
- `LLM_API_KEY` — required for the sentiment scraper (`backend/scrapers/sentiment.js`) to call DeepSeek's chat-completions API. Not provisioned anywhere in this repo — a manual step outside it. Without it, `refreshSentiment()` fails cleanly rather than writing a bad reading.
- `SENTIMENT_LLM_MODEL` — optional, overrides the sentiment-scoring model (default: `deepseek-chat`)

## Testing Locally

No hosted dev server, but you can verify before deploying:

- **Frontend:** run a tiny static server over `frontend/` that returns a saved copy of the live API for `/api/ad` (`curl https://finance.sulaksono.id/api/ad -o /tmp/ad.json`) — and `/api/movers` the same way, or `computeMovers` run over your own fetched bars — then drive it in a browser. All indicators are client-side, so this exercises real behavior against real data. (Charts render on canvas — screenshot to verify.) The weekly panels (Stochastic, Shinohara) need a **long** reading period to show anything; the default range is One Year for that reason.
- **Valuation:** `buildValuations` needs no AWS creds — run it straight to a file and serve that as `/api/valuation`:
  `node -e "import('./backend/scrapers/valuation.js').then(async m=>{const{getAllTickers}=await import('./backend/lib/tickers.js');console.log(JSON.stringify(await m.buildValuations(await getAllTickers())))}"`
  (~10 min for the full universe at three calls per ticker). A single name is quick: `valuateTicker('BBCA.JK')`.
- **Backend / big repopulations:** run the handler locally against the **prod** DynamoDB table (region `ap-southeast-1`):
  `AWS_REGION=ap-southeast-1 TABLE_NAME=ihsg-adl node -e "import('./backend/index.js').then(m=>m.handler({source:'aws.events'}))"`
  (~5 min for the full 967-ticker scrape; needs AWS creds). The API read path is unchanged, so the live site reflects the new data immediately — no deploy needed for a data-only change. This same run also populates the 200-Week Trend Line page (it piggybacks on this scrape — see above) — a year of history behind it comes from the one-time `AWS_REGION=ap-southeast-1 TABLE_NAME=ihsg-adl node backend/backfill-ma200w.js`.
- **Unit tests:** `cd backend && npm test`.
- **Lambda debugging:** CloudWatch Logs.

For a normal frontend change, push to `main` and observe live.
