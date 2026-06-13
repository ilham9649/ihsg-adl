# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Serverless IHSG (Jakarta Composite Index) market breadth dashboard. Tracks ~500 IDX stocks daily, calculating A/D Line, A/D Ratio, Spread, and McClellan Oscillator.

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

### Ticker Discovery
`backend/lib/tickers.js` fetches IDX tickers from stockanalysis.com (3 pages, ~500 tickers). Falls back to hardcoded list of ~70 liquid LQ45 stocks if discovery fails. All tickers are suffixed with `.JK` for Yahoo Finance.

### Yahoo Finance Scraper
Uses Yahoo Finance v8 chart API directly (`/v8/finance/chart/{ticker}`) — no external library dependency. Rate limited by:
- Processing in batches of 3 tickers in parallel
- 2-second delay between batches
- Processes ~500 tickers in ~5-6 minutes

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
