#!/usr/bin/env node
// ============================================================
//  CB Fleet V2 — Self-Destruct Webhook
//  Runs as a silent background service on the VM.
//  Trigger: POST /destruct  { "code": "703881" }
//  Returns 200 + acks, then wipes the system.
// ============================================================

const http   = require('http');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const os     = require('os');

// ── Config ──────────────────────────────────────────────────
const PORT       = 9999;               // internal only, behind nginx
const CODE_HASH  = process.env.DESTRUCT_CODE_HASH || 'REPLACE_WITH_HASH';
const DESTRUCT_BIN = '/usr/local/sbin/fleet-destruct-exec'; // raw exec script (no code prompt)
const PHONE_HOME = process.env.DESTRUCT_PHONE_HOME || '';   // optional webhook notification

// ── Helpers ──────────────────────────────────────────────────
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function phoneHome(code_valid) {
  if (!PHONE_HOME) return;
  const payload = JSON.stringify({
    event:      'destruct_triggered',
    host:       os.hostname(),
    ip:         getIP(),
    valid_code: code_valid,
    at:         new Date().toISOString(),
  });
  const url = new URL(PHONE_HOME);
  const mod = url.protocol === 'https:' ? require('https') : http;
  try {
    const req = mod.request({ hostname: url.hostname, port: url.port||80, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    });
    req.write(payload);
    req.end();
  } catch {}
}

function getIP() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'unknown';
}

// ── HTTP server ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Health check — returns generic 200 so it looks like any service
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Destruct endpoint
  if (req.method === 'POST' && req.url === '/destruct') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let code = '';
      try { code = JSON.parse(body).code || ''; } catch {}

      const valid = sha256(code) === CODE_HASH;
      phoneHome(valid);

      if (!valid) {
        // Respond with 404 — don't reveal the endpoint exists
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // Acknowledge before wiping (response may not arrive — that's fine)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Acknowledged. Initiating.' }));

      // Give response 500ms to flush, then wipe
      setTimeout(() => {
        console.log(`[DESTRUCT] Triggered at ${new Date().toISOString()} from ${req.socket.remoteAddress}`);
        const child = spawn('bash', [DESTRUCT_BIN], {
          detached: true,
          stdio:    'ignore',
          env:      { ...process.env },
        });
        child.unref();
        // Kill this process too — it'll be gone with everything else
        setTimeout(() => process.exit(0), 2000);
      }, 500);
    });
    return;
  }

  // Everything else — 404
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[destruct-webhook] Listening on 127.0.0.1:${PORT}`);
});

process.on('uncaughtException', () => {}); // silent
