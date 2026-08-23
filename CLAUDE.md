# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Serverless IHSG (Jakarta Composite Index) market dashboard — **"The Jakarta Ledger"** (editorial broadsheet UI). Three pages: `index.html` (breadth & momentum), `valuation.html` (intrinsic value, cheapest to dearest — see *Valuation page* below), and `sentiment.html` (LLM-scored daily market sentiment — see *Sentiment page* below). Tracks the **full IDX listing (~957 stocks, all boards)** daily. The backend computes per-day breadth metrics (**% Advancing**, spread, A/D ratio, McClellan, `adLine`) and stores the IHSG index OHLC; the frontend adds index-price and momentum views. Panels: IHSG candles, the % Advancing breadth line (20/100/200-day MA ribbon), the Zweig Breadth Thrust, weekly Stochastic, and the Shinohara Intensity Ratio. (The A/D Ratio and McClellan *chart panels* were removed from the UI; those values are still computed and shown in the top indicator strip.)

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
- **Zweig Breadth Thrust** — `attachThrust` computes a 10-day EMA of `pctAdvancing` (`zbt`) and flags the canonical trigger (≤40 → ≥61.5 within 10 sessions) as `thrust`. ⚠️ **The trigger has never fired on the IDX universe** — the record high is 60.66 over 7.5 years, and the panel copy states this. That empty upper band *is* the finding (same story as the A/D Line drift above); do not "fix" it by lowering the threshold to manufacture signals. Verified the detector itself works: at a 55 threshold it fires on the real selloff bottoms (2019-06-10, 2025-04-14, 2026-06-15/07-07/07-14).
- **Stochastic (15,3,3)** — `attachStochastic` aggregates IHSG OHLC to **weekly** bars → `stochK`/`stochD`.
- **Shinohara Intensity Ratio (26)** — `attachShinohara` uses **Yahoo's exact ChartIQ formula** so the numbers match Yahoo Finance's display: `Strong = 100·Σ(High−prevClose)/Σ(prevClose−Low)`, `Weak = 100·Σ(High−Close)/Σ(Close−Low)` over 26 **weekly** bars (`shinStrong`/`shinWeak`). ⚠️ The textbook Shinohara / AR-BR uses High−**Open** and does NOT match Yahoo — don't "correct" it to that. The panel charts the `shinSpread` (`Weak − Strong`) directly, since the gap *is* the reading; >100 = "extremely oversold" and is shaded.
- **Cross-chart hover sync** (`HoverSync`) — hovering any panel highlights the same date on all of them (all panels share the filtered-data index).
- **Reading period** — `getFilteredData` slices `allData` by trailing row count, plus a special `ytd` value (filter from Jan 1 of the current year).

### Valuation page (`frontend/valuation.html`)
A **second page** — "The Valuation Column" — ranking the IDX listing cheapest to dearest by estimated intrinsic value. Unlike every indicator on the front page, this is **not** computed client-side: the frontend only filters and renders what `GET /api/valuation` returns.

**Two models, because one does not fit both kinds of business** (`backend/scrapers/valuation.js`):
- **Operating companies → two-stage DCF.** 5 years of FCF grown at the company's revenue CAGR (clamped 0–15%), Gordon terminal value, discounted at 13%. Equity = EV − debt + cash.
- **Financials → residual income (excess return).** ⚠️ **Never run a FCF-DCF on a bank.** Yahoo reports 75T "free cash flow" for BBCA — that is deposit and lending flow, i.e. the balance sheet, not owner earnings, and a DCF reads it as enormous wealth. The excess-return model values a bank as `book value + PV[(ROE − Ke) × book]`, so a bank earning exactly its cost of equity is worth exactly book. Growth is the sustainable rate `ROE × (1 − payout)`, capped below the discount rate or the terminal value goes infinite/negative. Routed by `isFinancial()` on the Yahoo `sector` field.

Both return a per-share number, so the two sets rank in one list.

> **Data source: `ws/fundamentals-timeseries`, not `quoteSummary`.** The `v10/finance/quoteSummary` endpoint now returns **401** (needs a crumb + cookie). The fundamentals-timeseries endpoint serves annual FCF, revenue, debt, cash, net income, equity, dividends and share count with **no auth**. Sector/industry comes from `v1/finance/search` — also free. Do not "fix" this by reintroducing quoteSummary.

**Known limits — these are honest constraints, not bugs to patch:** Yahoo publishes only ~4 years of annuals (from ~2022), so growth rests on a short history; every name is discounted at a flat 13% (no per-name beta — four annual reports cannot support that precision); loss-making and non-filing companies get **no valuation** and are absent from the table rather than shown as cheap. The page states all of this in its method note. It ranks; it does not price.

**The spread figure** (`renderSpread` in `valuation.js`) is the page's signature: one hairline per company on a `log₂(fairValue / price)` axis, **left = cheap**, drawn as inline SVG (not `BreadthChart` — that panel is built for time series, and this is a 1-D distribution; no library was added). Log scale because the raw discount runs −1240%…+685% and collapses to a smear on a linear axis. The axis floor is `VOID_FLOOR = -6`; below that the estimate is under a sixtieth of the price, which is an artefact of rounding a near-zero fair value rather than a reading, so those join the **no-value block** past a broken-axis mark. That block is ~118 of 390 — the biggest single finding on the page, so it is deliberately the heaviest object in the figure. Hairlines are drawn at low opacity so crowding darkens the field on its own. Filtering the table dims non-matching hairlines rather than re-scaling the figure, which would make the hero jump while someone types.

> **Readout text is built from DOM nodes, never `innerHTML`.** `ticker`/`name` come straight from Yahoo. The table takes the same care for the same reason.

**Storage:** one DynamoDB item, `date = "_valuation"`, holding the whole ranking as a JSON string plus `attempted`. Read and written whole, never queried per ticker. `getAllData()` filters on `attribute_exists(advances)` so this row (and the refresh lock) can never reach the daily-series parser.

**Scheduling:** valuations move only when a company files, so this runs on its **own** trigger — `POST /api/valuation/refresh`, or an EventBridge event with `job: "valuation"`. It must **not** share the daily breadth cron: each ticker costs three Yahoo calls (~967 × 3), so the two jobs together would exceed the 900s Lambda timeout. ⚠️ The second EventBridge rule lives in the infrastructure repo and is **not yet created** — until it is, run the refresh manually.

### Sentiment page (`frontend/sentiment.html`)
A **third page** — market-wide (not per-stock) daily sentiment, scored by an LLM from Indonesian financial news headlines. Score scale is **−100 (extremely bearish) to +100 (extremely bullish), 0 = neutral**.

**Pipeline** (`backend/scrapers/news.js` + `backend/scrapers/sentiment.js`): fetch CNBC Indonesia's market RSS feed (`https://www.cnbcindonesia.com/market/rss` — unlike `idx.co.id`, this feed does not block server-side fetches), filter to today's WIB-calendar-day headlines (falling back to the most recent ~20 headlines on a thin news day), and send them to DeepSeek's OpenAI-compatible chat-completions API via raw `fetch` (no SDK, matching this repo's zero-dependency scraper convention) with model `deepseek-chat` (overridable, see below). The feed mixes genuine market news with unrelated stories (disasters, banking how-tos); the prompt itself does the filtering, not the scraper. A response that fails to parse is discarded rather than stored — a phantom reading in the time series is worse than a skipped day.

> **Requires `LLM_API_KEY`** in the Lambda environment — not provisioned by this repo (see *Environment Variables* below). Until it's set, `refreshSentiment()` fails cleanly (no key, no write).

**Storage:** one DynamoDB item **per day**, like the daily breadth rows, but under key `sent#YYYY-MM-DD` — a distinct prefix from the plain `date` key so it can never collide with, or be clobbered by, the breadth refresh's full-item overwrite for that same calendar day. `getAllSentiment()` scans on `begins_with(date, "sent#")`.

**Scheduling:** sentiment moves once a day off one RSS fetch and one LLM call (seconds, not minutes), so like valuation it runs on its **own** trigger — `POST /api/sentiment/refresh`, or an EventBridge event with `job: "sentiment"`. ⚠️ Same caveat as valuation: the EventBridge rule lives in the infrastructure repo and is **not yet created** — until it is, run the refresh manually. Unlike valuation's ~500s job, this one is fast enough that the **Re-read** button on the page goes straight through API Gateway without hitting its 29s cap.

**Known limits — stated on the page itself:** it's one LLM's read of one day's headlines from one news feed, not a rigorous signal — the same headlines re-read, or read by a different model, would not always file the same number. The RSS feed only exposes a rolling window, not a deep archive, so there is no historical backfill: the trend line starts thin and lengthens by one point a day going forward.

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

- **Frontend:** run a tiny static server over `frontend/` that returns a saved copy of the live API for `/api/ad` (`curl https://finance.sulaksono.id/api/ad -o /tmp/ad.json`), then drive it in a browser. All indicators are client-side, so this exercises real behavior against real data. (Charts render on canvas — screenshot to verify.) The weekly panels (Stochastic, Shinohara) need a **long** reading period to show anything; the default range is One Year for that reason.
- **Valuation:** `buildValuations` needs no AWS creds — run it straight to a file and serve that as `/api/valuation`:
  `node -e "import('./backend/scrapers/valuation.js').then(async m=>{const{getAllTickers}=await import('./backend/lib/tickers.js');console.log(JSON.stringify(await m.buildValuations(await getAllTickers())))}"`
  (~10 min for the full universe at three calls per ticker). A single name is quick: `valuateTicker('BBCA.JK')`.
- **Backend / big repopulations:** run the handler locally against the **prod** DynamoDB table (region `ap-southeast-1`):
  `AWS_REGION=ap-southeast-1 TABLE_NAME=ihsg-adl node -e "import('./backend/index.js').then(m=>m.handler({source:'aws.events'}))"`
  (~5 min for the full 967-ticker scrape; needs AWS creds). The API read path is unchanged, so the live site reflects the new data immediately — no deploy needed for a data-only change.
- **Unit tests:** `cd backend && npm test`.
- **Lambda debugging:** CloudWatch Logs.

For a normal frontend change, push to `main` and observe live.
