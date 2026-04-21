#!/bin/bash
# Inject cookies into all worker Chrome instances
WORKER_COUNT=${1:-3}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

for i in $(seq 1 $WORKER_COUNT); do
  echo "Injecting cookies for worker $i..."
  bash "$SCRIPT_DIR/inject-cookies-worker.sh" "$i" &
done

wait
echo "All workers injected."
