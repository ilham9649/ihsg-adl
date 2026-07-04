# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Serverless IHSG (Jakarta Composite Index) market breadth dashboard. Tracks the **full IDX listing (~957 stocks, all boards)** daily, calculating **% Advancing** (20/100/200-day MAs), A/D Ratio, Spread, and McClellan Oscillator.

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

### Deployment
Push to `main` triggers GitHub Actions:
1. Frontend: `aws s3 sync` to S3, CloudFront invalidation
2. Backend: `npm ci`, zip, `lambda update-function-code`

## Environment Variables

- `TABLE_NAME` — DynamoDB table name (default: `ihsg-adl`)

## Testing Locally

No local test runner exists. To test backend changes:
1. Build zip: `npm run zip`
2. Deploy manually or push to main (triggers CI/CD)
3. Use CloudWatch Logs for Lambda debugging

For frontend changes, deploy and observe live — no local dev server.
