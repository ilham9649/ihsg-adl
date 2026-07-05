# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Serverless IHSG (Jakarta Composite Index) market dashboard — **"The Jakarta Ledger"** (editorial broadsheet UI). Tracks the **full IDX listing (~957 stocks, all boards)** daily. The backend computes per-day breadth metrics (**% Advancing**, spread, A/D ratio, McClellan, `adLine`) and stores the IHSG index OHLC; the frontend adds index-price and momentum views. Panels: IHSG candles, the % Advancing breadth line (20/100/200-day MA ribbon), weekly Stochastic, and the Shinohara Intensity Ratio. (The A/D Ratio and McClellan *chart panels* were removed from the UI; those values are still computed and shown in the top indicator strip.)

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

### Ticker Universe
`backend/lib/tickers.js` hardcodes the **complete IDX securities list (~957 tickers, all boards: Main/Development/Acceleration/Watchlist)**, scraped from the IDX official API (`idx.co.id` `GetSecuritiesStock`). It's hardcoded because IDX's API blocks server-side fetches (Cloudflare/403) and stockanalysis.com's free list caps at 500 — so live discovery from Lambda isn't possible. **Re-scrape periodically** to pick up new IPOs (drive `idx.co.id/en/market-data/stocks-data/stock-list` in a browser and fetch its API in-page). Many small/suspended names have no usable Yahoo data — `fetchQuotes` returns `[]` for those and they're excluded from the daily counts (~750-850 of 957 typically usable). All tickers suffixed `.JK`.

> **Refresh scale & API Gateway 29s limit:** a ~957-ticker × 7.5-year scrape takes several minutes (batches of 6, 1.5s apart; daily counts folded incrementally to bound memory). The scheduled EventBridge run invokes the Lambda directly, bounded only by the Lambda timeout (900s — keep it there). The manual `POST /api/ad/refresh` **Refresh** button goes through API Gateway (~29s cap) so it returns 504 even though the Lambda keeps running and still writes the data. Treat the daily cron as the source of truth; big repopulations can be run locally against the prod table.

### Yahoo Finance Scraper
Uses Yahoo Finance v8 chart API directly (`/v8/finance/chart/{ticker}`) — no external library dependency. Rate limited by:
- Processing in batches of 6 tickers in parallel
- 1.5-second delay between batches
- Processes ~957 tickers in ~5-8 minutes (no-data micro-caps 404 fast, so failures don't slow it much)

### DynamoDB Pattern
Table: `ihsg-adl` (or `TABLE_NAME` env var). Primary key is `date` (string S). Stores aggregated daily metrics, not per-ticker data. `BatchWriteItem` chunks at 25 items max.

### Frontend Indicators (computed client-side, `frontend/app.js`)
Everything the frontend charts is **derived in the browser** from what the API already returns (daily breadth counts + IHSG OHLC) — there are **no dedicated backend/DB fields** for these, so tuning them needs only a frontend deploy (no re-refresh):
- **% Advancing MA ribbon** — `attachPctSmoothing` computes 20/100/200-day SMAs of `pctAdvancing` over the full series (`pctAdvancingMA`/`...MA100`/`...MA200`). Drawn by the custom canvas chart `frontend/breadth-chart.js` as a ribbon with a toggle checklist, a faint daily dot-cloud (raw `pctAdvancing`), and the 50% neutral line. The chart also powers the IHSG candles panel.
- **Stochastic (15,3,3)** — `attachStochastic` aggregates IHSG OHLC to **weekly** bars → `stochK`/`stochD`.
- **Shinohara Intensity Ratio (26)** — `attachShinohara` uses **Yahoo's exact ChartIQ formula** so the numbers match Yahoo Finance's display: `Strong = 100·Σ(High−prevClose)/Σ(prevClose−Low)`, `Weak = 100·Σ(High−Close)/Σ(Close−Low)` over 26 **weekly** bars (`shinStrong`/`shinWeak`). `Weak − Strong > 100` = "extremely oversold". ⚠️ The textbook Shinohara / AR-BR uses High−**Open** and does NOT match Yahoo — don't "correct" it to that.
- **Cross-chart hover sync** (`HoverSync`) — hovering any panel highlights the same date on all of them (both the custom-canvas and Chart.js panels share the filtered-data index).
- **Reading period** — `getFilteredData` slices `allData` by trailing row count, plus a special `ytd` value (filter from Jan 1 of the current year).

### Deployment
Push to `main` triggers GitHub Actions:
1. Frontend: `aws s3 sync` to S3, CloudFront invalidation
2. Backend: `npm ci`, zip, `lambda update-function-code`

## Environment Variables

- `TABLE_NAME` — DynamoDB table name (default: `ihsg-adl`)

## Testing Locally

No hosted dev server, but you can verify before deploying:

- **Frontend:** run a tiny static server over `frontend/` that returns a saved copy of the live API for `/api/ad` (`curl https://finance.sulaksono.id/api/ad -o /tmp/ad.json`), then drive it in a browser. All indicators are client-side, so this exercises real behavior against real data. (Charts render on canvas / Chart.js — screenshot to verify.)
- **Backend / big repopulations:** run the handler locally against the **prod** DynamoDB table (region `ap-southeast-1`):
  `AWS_REGION=ap-southeast-1 TABLE_NAME=ihsg-adl node -e "import('./backend/index.js').then(m=>m.handler({source:'aws.events'}))"`
  (~5 min for the full 957-ticker scrape; needs AWS creds). The API read path is unchanged, so the live site reflects the new data immediately — no deploy needed for a data-only change.
- **Unit tests:** `cd backend && npm test`.
- **Lambda debugging:** CloudWatch Logs.

For a normal frontend change, push to `main` and observe live.
