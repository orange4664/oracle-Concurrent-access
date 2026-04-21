const fs = require("fs");
const p = process.argv[2] || __dirname + "/oracle-multi-tab/dist/src/remote/server.js";
let c = fs.readFileSync(p, "utf8");

// Use this to produce a literal \n in the output file (not a real newline)
const NL = String.fromCharCode(92) + "n"; // backslash + n

// 1. Queue state after activeRuns
c = c.replace(
  "    let activeRuns = 0;",
  [
    "    let activeRuns = 0;",
    "    const maxQueue = 25;",
    "    const queue = [];",
    "    function drainQueue() {",
    "        while (queue.length > 0 && activeRuns < maxConcurrent) {",
    "            const next = queue.shift();",
    "            queue.forEach((item, i) => {",
    "                if (!item.res.writableEnded) {",
    '                    item.res.write(JSON.stringify({ type: "queue_update", position: i + 1, total: queue.length }) + "' + NL + '");',
    "                }",
    "            });",
    "            next.resolve();",
    "        }",
    "    }",
  ].join("\n")
);

// 2. Replace 409 busy block with queue logic
const oldBusy = [
  "        if (activeRuns >= maxConcurrent) {",
  "            if (verbose) {",
  "                logger(`[serve] Busy: rejecting new run from ${formatSocket(req)} (${activeRuns}/${maxConcurrent} slots used)`);",
  "            }",
  '            res.writeHead(409, { "Content-Type": "application/json" });',
  '            res.end(JSON.stringify({ error: "busy", activeRuns, maxConcurrent }));',
  "            return;",
  "        }",
  "        activeRuns += 1;",
].join("\n");

const newBusy = [
  "        let queued = false;",
  "        if (activeRuns >= maxConcurrent) {",
  "            if (queue.length >= maxQueue) {",
  "                logger(`[serve] Queue full: rejecting from ${formatSocket(req)} (${queue.length}/${maxQueue})`);",
  '                res.writeHead(503, { "Content-Type": "application/json" });',
  '                res.end(JSON.stringify({ error: "queue_full", message: `All ${maxConcurrent} slots busy, queue full (${maxQueue}).`, queueLength: queue.length }));',
  "                return;",
  "            }",
  '            res.writeHead(200, { "Content-Type": "application/x-ndjson" });',
  "            const position = queue.length + 1;",
  "            logger(`[serve] Queued request from ${formatSocket(req)} at position ${position}`);",
  '            res.write(JSON.stringify({ type: "queue", position, totalSlots: maxConcurrent, message: `\u6392\u961f\u4e2d\uff0c\u524d\u65b9 ${position - 1} \u4eba\uff0c\u5171 ${maxConcurrent} \u4e2a\u5e76\u53d1\u69fd\u4f4d\u3002` }) + "' + NL + '");',
  "            queued = true;",
  "            await new Promise((resolve) => {",
  "                const item = { resolve, res };",
  "                queue.push(item);",
  '                res.on("close", () => {',
  "                    const idx = queue.indexOf(item);",
  "                    if (idx !== -1) {",
  "                        queue.splice(idx, 1);",
  "                        logger(`[serve] Queued client disconnected, removed from queue`);",
  "                        queue.forEach((q, i) => {",
  "                            if (!q.res.writableEnded) {",
  '                                q.res.write(JSON.stringify({ type: "queue_update", position: i + 1, total: queue.length }) + "' + NL + '");',
  "                            }",
  "                        });",
  "                    }",
  "                });",
  "            });",
  "            if (res.writableEnded) return;",
  '            res.write(JSON.stringify({ type: "queue_done", message: "\u8f6e\u5230\u4f60\u4e86\uff0c\u6b63\u5728\u5904\u7406..." }) + "' + NL + '");',
  "        }",
  "        activeRuns += 1;",
].join("\n");

c = c.replace(oldBusy, newBusy);

// 3. Skip writeHead if already queued (second occurrence)
const wh = '        res.writeHead(200, { "Content-Type": "application/x-ndjson" });';
const first = c.indexOf(wh);
const second = c.indexOf(wh, first + 1);
if (second !== -1) {
  c = c.slice(0, second) +
    '        if (!queued) { res.writeHead(200, { "Content-Type": "application/x-ndjson" }); }' +
    c.slice(second + wh.length);
  console.log("Replaced second writeHead");
}

// 4. drainQueue in finally + safe res.end
c = c.replace(
  "        finally {\n            activeRuns -= 1;\n            res.end();",
  "        finally {\n            activeRuns -= 1;\n            if (!res.writableEnded) res.end();\n            drainQueue();"
);

// 5. optional chaining
c = c.replace(/payload\.options\.verbose/g, "payload.options?.verbose");
c = c.replace(/payload\.options\.heartbeatIntervalMs/g, "payload.options?.heartbeatIntervalMs");

fs.writeFileSync(p, c);
console.log("Patched:", p);

// Verify
["maxQueue","drainQueue","queue_full","queue_done","payload.options?.verbose"].forEach(k => {
  if (!c.includes(k)) throw new Error(k + " missing");
});
console.log("All checks passed");
