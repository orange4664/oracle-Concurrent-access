#!/bin/bash
# Inject cookies into a specific worker's Chrome instance
# Usage: inject-cookies-worker.sh <worker_number>

WORKER_NUM=${1:-1}
SERVICE_NAME="oracle-worker-$WORKER_NUM"
WORKER_DIR="/opt/oracle-worker-$WORKER_NUM"
COOKIES_FILE="$WORKER_DIR/.oracle/cookies.json"

if [ ! -f "$COOKIES_FILE" ]; then
  echo "[$SERVICE_NAME] No cookies.json found at $COOKIES_FILE"
  exit 1
fi

# Read DevTools port from worker's journal logs
PORT=$(journalctl -u "$SERVICE_NAME" --no-pager -n 30 | grep -oP "Manual-login Chrome DevTools port: \K\d+" | tail -1)

if [ -z "$PORT" ]; then
  # Fallback: try reading from DevToolsActivePort file
  DTAP="$WORKER_DIR/.oracle/browser-profile/DevToolsActivePort"
  if [ -f "$DTAP" ]; then
    PORT=$(head -1 "$DTAP")
  fi
fi

if [ -z "$PORT" ]; then
  echo "[$SERVICE_NAME] Could not find DevTools port"
  exit 1
fi

echo "[$SERVICE_NAME] Injecting cookies on DevTools port $PORT..."
node /opt/oracle-concurrent/scripts/inject-cookies.js "$PORT" "$COOKIES_FILE"
echo "[$SERVICE_NAME] Done"
