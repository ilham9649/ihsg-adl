#!/usr/bin/env bash
# Daily Bandarmology job on the openclaw server (cron, weekdays after the close).
# 1. fetch Stockbit inputs into the cache  2. compute and store in DynamoDB.
# If the Stockbit login has expired the fetch exits 3 and nothing is stored, so
# the page keeps yesterday's reading and its freshness pill turns red after a
# few days. Renew with: python3 ~/.openclaw/workspace/skills/stockbit/scripts/stockbit_ensure_token.py
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
LOG="${BANDARMOLOGY_LOG:-/root/bandarmology-cache/job.log}"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "=== $(date -u +%FT%TZ) bandarmology run"
python3 "$DIR/fetch_stockbit.py" "$@"
rc=$?
if [ $rc -eq 3 ]; then echo "Stockbit login expired: nothing stored today"; exit 3; fi
if [ $rc -ne 0 ]; then echo "fetch failed ($rc): building from what is cached"; fi
cd "$ROOT" && AWS_REGION="${AWS_REGION:-ap-southeast-1}" TABLE_NAME="${TABLE_NAME:-ihsg-adl}" node "$DIR/build.mjs"
