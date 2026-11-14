#!/usr/bin/env bash
# Copy the job and the backend code it shares to the openclaw server, and
# install the one dependency (the DynamoDB client). Run from anywhere:
#   jobs/bandarmology/deploy.sh user@host     (or set BANDARMOLOGY_HOST)
set -euo pipefail
HOST="${1:-${BANDARMOLOGY_HOST:?usage: deploy.sh user@host (or set BANDARMOLOGY_HOST)}}"
REMOTE=/root/bandarmology
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ssh "$HOST" "mkdir -p $REMOTE/jobs/bandarmology $REMOTE/backend/scrapers $REMOTE/backend/lib"
scp -q "$ROOT"/jobs/bandarmology/{fetch_stockbit.py,build.mjs,hsc.mjs,run.sh} "$HOST:$REMOTE/jobs/bandarmology/"
scp -q "$ROOT"/backend/scrapers/{lpm.js,bandarmology.js} "$HOST:$REMOTE/backend/scrapers/"
scp -q "$ROOT"/backend/lib/{db.js,tickers.js,ihsg-rules.js} "$HOST:$REMOTE/backend/lib/"
scp -q "$ROOT"/backend/{package.json,package-lock.json} "$HOST:$REMOTE/backend/"
ssh "$HOST" "chmod +x $REMOTE/jobs/bandarmology/run.sh && cd $REMOTE/backend && npm ci --omit=dev --silent && echo deployed to $REMOTE"
