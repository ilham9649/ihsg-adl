# IHSG Advance/Decline Index

Dashboard for tracking IHSG (Jakarta Composite Index) market breadth.

**Live:** [finance.sulaksono.id](https://finance.sulaksono.id)

## Metrics

- **A/D Line** — Cumulative advances minus declines
- **A/D Ratio** — Daily advances / declines
- **A/D Spread** — Daily advances minus declines
- **McClellan Oscillator** — EMA(19) - EMA(39) of daily spread

## Architecture

```
┌─────────────────────┐     ┌──────────────────┐     ┌───────────┐
│  S3 + CloudFront    │────▶│  API Gateway v2   │────▶│  Lambda   │
│  (frontend)         │     │  (HTTP API)       │     │  (Node.js)│
│  finance.sulaksono.id     └──────────────────┘     └─────┬─────┘
└─────────────────────┘                                     │
                                                            ▼
                                                   ┌───────────────┐
                                                   │  DynamoDB     │
                                                   │  (A/D data)   │
                                                   └───────────────┘
                                                            ▲
                                                            │
                                                   ┌───────────────┐
                                                   │ EventBridge   │
                                                   │ (daily cron   │
                                                   │  17:00 WIB)   │
                                                   └───────┬───────┘
                                                           │
                                                   ┌───────▼───────┐
                                                   │  Lambda       │
                                                   │  (scraper)    │
                                                   └───────────────┘
```

## Data Source

Yahoo Finance API — daily OHLC for all IHSG constituents (~900 stocks).

## Deployment

Push to `main` → GitHub Actions auto-deploys:
- Frontend → S3 + CloudFront
- Backend → Lambda update

Infrastructure managed in [ilham9649/infrastructure](https://github.com/ilham9649/infrastructure) (`terraform/finance-adl/`).
