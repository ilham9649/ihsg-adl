# The Jakarta Ledger

Dashboard for the IHSG (Jakarta Composite Index), in two sections:

- **A — Breadth & Momentum** — how many stocks rose, and how the index moved
- **B — Valuation** — what each listed company is worth, ranked cheapest to dearest

**Live:** [finance.sulaksono.id](https://finance.sulaksono.id)

## Metrics

- **A/D Ratio** — Daily advances / declines
- **A/D Spread** — Daily advances minus declines
- **McClellan Oscillator** — EMA(19) - EMA(39) of daily spread

> **No cumulative A/D Line.** A running cumulative (advances − declines) was removed: computed from raw (unadjusted) closes, every ex-dividend day is miscounted as a "decline", producing a one-directional downward bias that compounds monotonically (it fell ~16,000 over 3 years *during* a +28% index rally — the opposite of a real A/D Line, which rises in bull markets). The non-cumulative metrics above are unaffected.

## Valuation methods

Section B estimates what each company is worth from its own filed accounts, then ranks the board by the gap between that estimate and the market price. Two methods are in use, chosen per company:

| Method | Applies to | Core idea |
|---|---|---|
| **Discounted cash flow** | Operating companies | A business is worth the cash it can hand its owners, discounted back to today |
| **Residual income** (excess return) | Banks, insurers | A lender is worth its book value plus only the returns it earns *above* its cost of equity |

Both produce a value per share, so the two sets rank against each other in one list.

### Discounted cash flow

1. Take **normalized free cash flow** — the median of the filed periods, not the latest, so one asset sale cannot become a perpetuity.
2. Grow it for **five years** at the company's own revenue CAGR, capped at 15%.
3. Add a **terminal value** for everything after, at 4% perpetual growth.
4. Discount it all at **13%**, then subtract debt and add cash to reach what shareholders own.

### Residual income

Free cash flow is meaningless for a bank — the reported figure is deposit and lending flow, so it measures the balance sheet rather than the business, and a DCF reads it as enormous wealth. Instead:

```
value = book value + Σ PV[(ROE − cost of equity) × book value] + terminal
```

A bank earning exactly its 13% cost of equity is worth exactly its book and no more. Growth is the sustainable rate `ROE × (1 − payout)`, capped below the discount rate.

### Assumptions

| | | |
|---|---|---|
| Discount rate | 13% | Indonesian 10-year yield plus an equity risk premium, applied flat to every company |
| Terminal growth | 4% | Long-run nominal growth |
| Forecast horizon | 5 years | |
| Accounts | Trailing twelve months where a company files four clean consecutive quarters (~38% of the universe), its last full financial year otherwise | Yahoo's quarterly series has gaps; four values spanning fifteen months is not a year |

**Limits.** A flat discount rate treats a utility and a mining junior as equally risky. Growth is read from roughly four years of history. Companies that lose money, file nothing, or carry no sector are absent from the ranking rather than shown as cheap — without a sector we cannot tell which method applies, and a wrong method is worse than no number. These figures rank; they do not price.

### Adding a method

Method selection lives in one place: `valuateTicker` in `backend/scrapers/valuation.js` picks by sector and calls a function that returns `{ fairValue, growth, model, basis, asOf }`. A third method is a new function plus a branch there — there is deliberately no plugin layer for two implementations.

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

## Data source

Yahoo Finance, no authentication required:

- **Prices** — `/v8/finance/chart` daily OHLC for the full IDX listing (~967 tickers)
- **Accounts** — `/ws/fundamentals-timeseries` annual and quarterly figures. (`/v10/finance/quoteSummary` now returns 401 and is not used.)
- **Sector** — `/v1/finance/search`, which decides the valuation method

## Deployment

Push to `main` → GitHub Actions auto-deploys:
- Frontend → S3 + CloudFront
- Backend → Lambda update

Infrastructure managed in [ilham9649/infrastructure](https://github.com/ilham9649/infrastructure) (`terraform/finance-adl/`).
