#!/usr/bin/env bash
# Fill a separate demo database from the local mock server (no traffic to Google)
# and start the dashboard. Usage:
#   DEMO_DATABASE_URL=postgres://crawler:pass@localhost/playstore_demo ./demo/run-demo.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DEMO_DATABASE_URL:?set DEMO_DATABASE_URL to an EMPTY demo database (not your real one)}"

node demo/mock-play.mjs & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 0.5

export DATABASE_URL="$DEMO_DATABASE_URL" PLAY_BASE_URL=http://127.0.0.1:8099 \
  MIN_REQUEST_INTERVAL_MS=30 REQUEST_JITTER_MS=20 MAX_REQUESTS_PER_MINUTE=600 BACKOFF_BASE_MS=300 LOG_LEVEL=warn
node src/cli.js migrate
node src/cli.js seed dev.demo.pixelnotes dev.demo.swiftstudio dev.demo.cobaltcoach dev.demo.ghostapp
for d in 0 1 2 3 4 5; do   # six simulated "days" so the history charts have data
  curl -s "http://127.0.0.1:8099/__day?d=$d" >/dev/null
  if [ "$d" -gt 0 ]; then node src/cli.js mark-all-due >/dev/null; node src/cli.js crawl --force || true
  else node src/cli.js crawl || true; fi
done
echo "Dashboard: http://127.0.0.1:${DASHBOARD_PORT:-8080}/  (Ctrl+C to stop)"
LOG_LEVEL=info node src/cli.js serve
