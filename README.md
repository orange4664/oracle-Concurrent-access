# Oracle Concurrent Access

Oracle dispatcher with 3-worker concurrency and request queue.

## Architecture

```
Client → Dispatcher (:3080) → Worker 1 (:3081) → Chrome + ChatGPT
                             → Worker 2 (:3082) → Chrome + ChatGPT
                             → Worker 3 (:3083) → Chrome + ChatGPT
                             → Queue (if all busy)
```

- **Dispatcher** sits on port 3080, transparent proxy to Oracle serve workers
- **3 Workers** each run `oracle serve` with independent Chrome instances
- **Queue** holds requests when all workers are busy, FIFO, max 20 by default
- Clients see queue position updates via NDJSON stream
- Fully compatible with existing Oracle CLI and MCP — no client changes needed

## API

Same as Oracle serve, plus:

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /status` | No | Liveness check |
| `GET /queue` | No | Queue & worker status |
| `GET /health` | Bearer | Authenticated health check |
| `POST /runs` | Bearer | Submit a run (proxied to worker or queued) |

### Queue behavior

When all workers are busy:
1. Request enters queue, client receives NDJSON: `{"type":"queue","position":1,...}`
2. As queue drains, clients receive: `{"type":"queue_update","position":N,...}`
3. When a worker frees up, the request is proxied and the real NDJSON response streams through
4. If queue is full (default 20), returns HTTP 503
5. If queued too long (default 5min), returns timeout

## Deploy

```bash
# On the server
git clone https://github.com/orange4664/oracle-Concurrent-access.git /opt/oracle-concurrent
cd /opt/oracle-concurrent

# Set your token (or edit setup.sh)
export ORACLE_TOKEN=your-token-here

# Run setup (creates systemd services, copies profiles, starts everything)
bash scripts/setup.sh
```

### Prerequisites

- Oracle CLI installed: `npm install -g git+https://github.com/orange4664/oracle.git`
- Xvfb running (for headed Chrome)
- SOCKS proxy if needed
- Browser profile with ChatGPT cookies at `/root/.oracle/`

### Re-inject cookies

After cookies expire or are updated:

```bash
# Copy new cookies to all workers
for i in 1 2 3; do
  cp /root/.oracle/cookies.json /opt/oracle-worker-$i/.oracle/cookies.json
done

# Inject into running Chrome instances
bash /opt/oracle-concurrent/scripts/inject-all.sh
```

### Service management

```bash
# Check status
systemctl status oracle-dispatcher oracle-worker-{1,2,3}

# Restart all
systemctl restart oracle-worker-{1,2,3} oracle-dispatcher

# View logs
journalctl -u oracle-dispatcher -f
journalctl -u oracle-worker-1 -f
```

## Config

Environment variables for the dispatcher:

| Variable | Default | Description |
|----------|---------|-------------|
| `DISPATCH_PORT` | 3080 | Dispatcher listen port |
| `WORKER_PORTS` | 3081,3082,3083 | Comma-separated worker ports |
| `ORACLE_TOKEN` | (empty) | Bearer token for auth |
| `MAX_QUEUE` | 20 | Max queued requests |
| `WORKER_TIMEOUT` | 180000 | Per-request timeout (ms) |
| `QUEUE_TIMEOUT` | 300000 | Max time in queue (ms) |

## License

MIT
