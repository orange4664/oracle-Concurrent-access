const http = require('http');

// --- Config ---
const WORKER_PORTS = (process.env.WORKER_PORTS || '3081,3082,3083')
  .split(',').map(p => parseInt(p.trim()));
const PORT = parseInt(process.env.DISPATCH_PORT || '3080');
const TOKEN = process.env.ORACLE_TOKEN || '';
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE || '20');
const WORKER_TIMEOUT = parseInt(process.env.WORKER_TIMEOUT || '180000');
const QUEUE_TIMEOUT = parseInt(process.env.QUEUE_TIMEOUT || '300000');

// --- State ---
const workers = WORKER_PORTS.map(port => ({ port, busy: false }));
const queue = [];
let jobCounter = 0;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function collectBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function queueInfo() {
  return {
    workers: workers.map(w => ({ port: w.port, busy: w.busy })),
    queueLength: queue.length,
    freeWorkers: workers.filter(w => !w.busy).length,
    busyWorkers: workers.filter(w => w.busy).length,
    maxQueue: MAX_QUEUE,
  };
}

// Stream-proxy a request to a worker (NDJSON passthrough)
function proxyStream(worker, method, url, headers, body, clientRes) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: worker.port,
      path: url,
      method,
      headers: { ...headers, host: `127.0.0.1:${worker.port}` },
      timeout: WORKER_TIMEOUT,
    };

    const proxyReq = http.request(opts, proxyRes => {
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes);
      proxyRes.on('end', resolve);
      proxyRes.on('error', reject);
    });

    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      reject(new Error('worker timeout'));
    });

    if (body && body.length > 0) proxyReq.write(body);
    proxyReq.end();
  });
}

async function handleJob(worker, job) {
  worker.busy = true;
  log(`[#${job.id}] → worker :${worker.port}`);

  try {
    await proxyStream(worker, job.method, job.url, job.headers, job.body, job.res);
    log(`[#${job.id}] done (worker :${worker.port}, ${Date.now() - job.timestamp}ms)`);
  } catch (err) {
    log(`[#${job.id}] error (worker :${worker.port}): ${err.message}`);
    if (!job.res.writableEnded) {
      job.res.writeHead(502, { 'Content-Type': 'application/json' });
      job.res.end(JSON.stringify({ error: 'worker_error', message: err.message }));
    }
  } finally {
    worker.busy = false;
    drainQueue();
  }
}

function drainQueue() {
  while (queue.length > 0) {
    const worker = workers.find(w => !w.busy);
    if (!worker) break;
    const job = queue.shift();
    clearTimeout(job.timer);
    // Notify remaining queued clients of updated position
    queue.forEach((j, i) => {
      if (!j.res.writableEnded && j.headersSent) {
        j.res.write(JSON.stringify({
          type: 'queue_update', position: i + 1, total: queue.length,
        }) + '\n');
      }
    });
    handleJob(worker, job);
  }
}

// --- Server ---
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

  // GET /status — unauthenticated, matches Oracle serve API
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // GET /queue — public queue status
  if (req.method === 'GET' && req.url === '/queue') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(queueInfo()));
  }

  // --- Auth required below ---
  const auth = req.headers['authorization'];
  if (TOKEN && auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }

  // GET /health — authenticated, aggregate worker health
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ...queueInfo() }));
  }

  // POST /runs — the main endpoint, proxy to worker or queue
  if (req.method === 'POST' && req.url === '/runs') {
    const body = await collectBody(req);
    const id = ++jobCounter;
    const job = {
      id, method: req.method, url: req.url,
      headers: req.headers, body, res,
      timestamp: Date.now(), timer: null, headersSent: false,
    };

    const worker = workers.find(w => !w.busy);

    if (worker) {
      handleJob(worker, job);
      return;
    }

    // All busy → queue
    if (queue.length >= MAX_QUEUE) {
      log(`[#${id}] rejected: queue full (${queue.length}/${MAX_QUEUE})`);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'queue_full',
        message: `All ${workers.length} workers busy, queue full (${MAX_QUEUE}). Try later.`,
        ...queueInfo(),
      }));
    }

    const position = queue.length + 1;
    log(`[#${id}] queued at position ${position}`);

    // Send NDJSON queue status (same content-type as Oracle serve response)
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({
      type: 'queue', position, totalWorkers: workers.length,
      message: `排队中，前方 ${position - 1} 人，共 ${workers.length} 个 worker。`,
    }) + '\n');
    job.headersSent = true;

    job.timer = setTimeout(() => {
      const idx = queue.indexOf(job);
      if (idx !== -1) {
        queue.splice(idx, 1);
        log(`[#${id}] queue timeout`);
        if (!res.writableEnded) {
          res.write(JSON.stringify({ type: 'error', message: 'Queue timeout' }) + '\n');
          res.end();
        }
      }
    }, QUEUE_TIMEOUT);

    queue.push(job);

    // Cleanup on client disconnect
    res.on('close', () => {
      const idx = queue.indexOf(job);
      if (idx !== -1) {
        queue.splice(idx, 1);
        clearTimeout(job.timer);
        log(`[#${id}] client disconnected, removed from queue`);
      }
    });
    return;
  }

  // Unknown endpoint
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(PORT, () => {
  log(`Oracle Dispatcher on :${PORT}`);
  log(`Workers: ${workers.map(w => ':' + w.port).join(', ')}`);
  log(`Max queue: ${MAX_QUEUE}`);
});
