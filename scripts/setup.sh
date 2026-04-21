#!/bin/bash
set -e

# --- Config ---
WORKER_COUNT=3
BASE_PORT=3081
DISPATCH_PORT=3080
TOKEN="${ORACLE_TOKEN:-oracle-fdu-2026}"
ORACLE_BIN=$(which oracle)

echo "=== Oracle Concurrent Access Setup ==="
echo "Workers: $WORKER_COUNT (ports $BASE_PORT-$((BASE_PORT + WORKER_COUNT - 1)))"
echo "Dispatcher: port $DISPATCH_PORT"
echo "Oracle binary: $ORACLE_BIN"
echo ""

# --- 1. Stop old single-instance oracle-serve ---
echo "[1/6] Stopping old oracle-serve..."
systemctl stop oracle-serve 2>/dev/null || true
systemctl disable oracle-serve 2>/dev/null || true

# --- 2. Create worker directories & copy browser profiles ---
echo "[2/6] Creating worker directories..."
for i in $(seq 1 $WORKER_COUNT); do
  WORKER_DIR="/opt/oracle-worker-$i"
  mkdir -p "$WORKER_DIR/.oracle"

  if [ -d /root/.oracle/browser-profile ]; then
    echo "  Copying browser profile to worker $i..."
    cp -r /root/.oracle/browser-profile "$WORKER_DIR/.oracle/browser-profile"
  fi

  if [ -f /root/.oracle/cookies.json ]; then
    cp /root/.oracle/cookies.json "$WORKER_DIR/.oracle/cookies.json"
  fi

  if [ -f /root/.oracle/config.json ]; then
    cp /root/.oracle/config.json "$WORKER_DIR/.oracle/config.json"
  fi
done

# --- 3. Create worker systemd services ---
echo "[3/6] Creating worker systemd services..."
for i in $(seq 1 $WORKER_COUNT); do
  PORT=$((BASE_PORT + i - 1))
  WORKER_DIR="/opt/oracle-worker-$i"

  cat > "/etc/systemd/system/oracle-worker-$i.service" <<EOF
[Unit]
Description=Oracle Worker $i (port $PORT)
After=xvfb.service socks-relay.service
Requires=xvfb.service socks-relay.service

[Service]
Environment=DISPLAY=:99
Environment=HOME=$WORKER_DIR
ExecStartPre=/bin/rm -f $WORKER_DIR/.oracle/browser-profile/DevToolsActivePort $WORKER_DIR/.oracle/browser-profile/Default/DevToolsActivePort
ExecStart=$ORACLE_BIN serve --port $PORT --token $TOKEN
ExecStartPost=/bin/bash -c 'sleep 10 && /opt/oracle-concurrent/scripts/inject-cookies-worker.sh $i'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
done

# --- 4. Install dispatcher ---
echo "[4/6] Installing dispatcher..."
mkdir -p /opt/oracle-concurrent
cp -r "$(dirname "$0")/../dispatcher.js" /opt/oracle-concurrent/
cp -r "$(dirname "$0")/../package.json" /opt/oracle-concurrent/
cp -r "$(dirname "$0")" /opt/oracle-concurrent/scripts/
chmod +x /opt/oracle-concurrent/scripts/*.sh

cat > "/etc/systemd/system/oracle-dispatcher.service" <<EOF
[Unit]
Description=Oracle Dispatcher (port $DISPATCH_PORT)
After=oracle-worker-1.service oracle-worker-2.service oracle-worker-3.service

[Service]
WorkingDirectory=/opt/oracle-concurrent
Environment=DISPATCH_PORT=$DISPATCH_PORT
Environment=WORKER_PORTS=$(seq -s, $BASE_PORT $((BASE_PORT + WORKER_COUNT - 1)))
Environment=ORACLE_TOKEN=$TOKEN
ExecStart=/usr/bin/node dispatcher.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# --- 5. Reload & start ---
echo "[5/6] Starting services..."
systemctl daemon-reload

for i in $(seq 1 $WORKER_COUNT); do
  systemctl enable "oracle-worker-$i"
  systemctl start "oracle-worker-$i"
  echo "  oracle-worker-$i started"
done

# Wait for workers to initialize
echo "  Waiting 15s for workers to start Chrome..."
sleep 15

systemctl enable oracle-dispatcher
systemctl start oracle-dispatcher
echo "  oracle-dispatcher started"

# --- 6. Verify ---
echo "[6/6] Verifying..."
echo ""
for i in $(seq 1 $WORKER_COUNT); do
  STATUS=$(systemctl is-active "oracle-worker-$i")
  echo "  oracle-worker-$i: $STATUS"
done
DISPATCH_STATUS=$(systemctl is-active oracle-dispatcher)
echo "  oracle-dispatcher: $DISPATCH_STATUS"

echo ""
echo "=== Setup Complete ==="
echo "Dispatcher: http://0.0.0.0:$DISPATCH_PORT"
echo "Queue status: http://0.0.0.0:$DISPATCH_PORT/queue"
echo "Token: $TOKEN"
