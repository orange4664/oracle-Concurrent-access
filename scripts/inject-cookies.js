const fs = require('fs');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const CDP_PORT = process.argv[2] || 45099;
const COOKIES_FILE = process.argv[3] || '/root/.oracle/cookies.json';

const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function main() {
  const targets = await get(`http://127.0.0.1:${CDP_PORT}/json`);
  const page = targets.find(t => t.type === 'page') || targets[0];
  if (!page) { console.log('No page target'); process.exit(1); }

  const wsUrl = page.webSocketDebuggerUrl;
  console.log('Connecting to', wsUrl);

  const url = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString('base64');

  const socket = net.createConnection(parseInt(url.port), url.hostname, () => {
    socket.write(
      `GET ${url.pathname} HTTP/1.1\r\n` +
      `Host: ${url.host}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`
    );
  });

  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let msgId = 1;
  const pending = {};

  function sendMsg(method, params) {
    return new Promise(resolve => {
      const id = msgId++;
      pending[id] = resolve;
      const payload = JSON.stringify({ id, method, params });
      const buf = Buffer.from(payload);
      const mask = crypto.randomBytes(4);
      let header;
      if (buf.length < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x81;
        header[1] = 0x80 | buf.length;
        mask.copy(header, 2);
      } else {
        header = Buffer.alloc(8);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(buf.length, 2);
        mask.copy(header, 4);
      }
      const masked = Buffer.alloc(buf.length);
      for (let i = 0; i < buf.length; i++) masked[i] = buf[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, masked]));
    });
  }

  function parseFrame(data) {
    if (data.length < 2) return null;
    const len = data[1] & 0x7f;
    let payloadStart = 2, payloadLen = len;
    if (len === 126) { payloadLen = data.readUInt16BE(2); payloadStart = 4; }
    else if (len === 127) { payloadLen = Number(data.readBigUInt64BE(2)); payloadStart = 10; }
    if (data.length < payloadStart + payloadLen) return null;
    return {
      payload: data.slice(payloadStart, payloadStart + payloadLen).toString(),
      totalLen: payloadStart + payloadLen,
    };
  }

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      upgraded = true;
      buffer = buffer.slice(end + 4);
      injectAll();
    }
    while (buffer.length > 0) {
      const frame = parseFrame(buffer);
      if (!frame) break;
      buffer = buffer.slice(frame.totalLen);
      try {
        const msg = JSON.parse(frame.payload);
        if (msg.id && pending[msg.id]) { pending[msg.id](msg); delete pending[msg.id]; }
      } catch {}
    }
  });

  async function injectAll() {
    let count = 0;
    for (const c of cookies) {
      const params = {
        name: c.name, value: c.value, domain: c.domain,
        path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
      };
      if (c.sameSite) {
        const map = { Strict: 'Strict', Lax: 'Lax', None: 'None' };
        params.sameSite = map[c.sameSite] || 'Lax';
      }
      if (c.expires) params.expires = c.expires;
      await sendMsg('Network.setCookie', params);
      count++;
    }
    console.log(`Injected ${count} cookies`);
    await sendMsg('Page.navigate', { url: 'https://chatgpt.com/' });
    console.log('Navigating to chatgpt.com');
    setTimeout(() => { socket.destroy(); process.exit(0); }, 3000);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
