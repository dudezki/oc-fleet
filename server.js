const http = require('http');
const express = require('express');
const fetch = require('node-fetch');
const { WebSocketServer } = require('ws');
const { exec, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const { chunkText, embedTexts } = require('../proxy/chunker');

const GEMINI_API_KEY = 'AIzaSyAksgdKNgnQ74ShoABJ2r6iik3yOXkqZUk';

const pgPool = new Pool({ connectionString: 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev' });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PROXY_PORT = 20000;
const ORG_ID = 'f86d92cb-db10-43ff-9ff2-d69c319d272d';
const KNOWN_PORTS = { sales: 20010, support: 20020, manager: 20030, dev: 20040, it: 20050 };

async function getInstances() {
  try {
    const r = await pgPool.query(
      "SELECT id, name, slug, config FROM fleet.agents WHERE org_id=$1 AND slug NOT IN ('rag','gemma') ORDER BY name",
      [ORG_ID]
    );
    return r.rows.map(a => {
      const port = KNOWN_PORTS[a.slug] || (() => {
        try {
          const cfg = JSON.parse(fs.readFileSync(
            path.join(os.homedir(), 'cbfleet-rag-' + a.slug, '.openclaw', 'openclaw.json'), 'utf8'
          ));
          return cfg.gateway?.port || null;
        } catch { return null; }
      })();
      const meta = a.config?.meta || {};
      return { name: a.slug, displayName: a.name, id: a.id, port, home: 'cbfleet-rag-' + a.slug, model: meta.model || 'haiku', provider: meta.provider || 'anthropic', emoji: meta.emoji || '🤖' };
    }).filter(i => i.port);
  } catch {
    return [
      { name: 'sales',   displayName: 'Fleet-Sales',   id: 'b81c0d8a-3f76-43fe-b2e5-2537801085dc', port: 20010, home: 'cbfleet-rag-sales' },
      { name: 'support', displayName: 'Fleet-Support', id: '325e5143-3c0b-4d65-b548-a34cbdba5949', port: 20020, home: 'cbfleet-rag-support' },
      { name: 'manager', displayName: 'Fleet-Manager', id: '82061d1c-2c79-4cfb-9e18-b8223b95a7c2', port: 20030, home: 'cbfleet-rag-manager' },
      { name: 'dev',     displayName: 'Fleet-Dev',     id: '87a2838e-e145-4f5c-99e2-c759f0591cba', port: 20040, home: 'cbfleet-rag-dev' },
      { name: 'it',      displayName: 'Fleet-IT',      id: '20dc090b-90a3-403f-acc3-a1ac7008596d', port: 20050, home: 'cbfleet-rag-it' },
    ];
  }
}

const AGENT_IDS = {
  sales:   'b81c0d8a-3f76-43fe-b2e5-2537801085dc',
  support: '325e5143-3c0b-4d65-b548-a34cbdba5949',
  manager: '82061d1c-2c79-4cfb-9e18-b8223b95a7c2',
  dev:     '87a2838e-e145-4f5c-99e2-c759f0591cba',
  it:      '20dc090b-90a3-403f-acc3-a1ac7008596d',
};

const uptimeMap = {};

// ── DB init ──────────────────────────────────────────────────────────────────

async function initDB() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS fleet.group_chats (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL,
      name TEXT NOT NULL,
      platform_group_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(org_id, platform_group_id)
    )
  `);
  await pgPool.query(`
    INSERT INTO fleet.group_chats (org_id, name, platform_group_id) VALUES
      ('f86d92cb-db10-43ff-9ff2-d69c319d272d', 'Sales Group',   '-1001000000001'),
      ('f86d92cb-db10-43ff-9ff2-d69c319d272d', 'Support Group', '-1001000000002'),
      ('f86d92cb-db10-43ff-9ff2-d69c319d272d', 'All Hands',     '-1001000000003')
    ON CONFLICT DO NOTHING
  `);
}
initDB().catch(err => console.error('DB init error:', err.message));

// ── WebSocket setup ──────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const wsClients = new Set();

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  wsClients.add(ws);

  // Send current state immediately on connect
  if (lastState !== null) {
    ws.send(JSON.stringify({ type: 'state', data: lastState }));
  } else {
    // First client — trigger immediate state collect
    collectState().then(s => {
      lastState = s;
      lastStateJson = JSON.stringify(s);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'state', data: s }));
    }).catch(() => {});
  }

  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  }
}

// ── Health helpers ───────────────────────────────────────────────────────────

async function checkHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkProxy() {
  try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/fleet-api/retrieve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: ORG_ID }), signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function killPort(port) {
  return new Promise((resolve) => {
    // -sTCP:LISTEN ensures we only kill the process listening on the port,
    // not the dashboard itself which may have an outbound connection to it.
    exec(`lsof -ti :${port} -sTCP:LISTEN`, (err, stdout) => {
      if (err || !stdout.trim()) return resolve();
      const pids = stdout.trim().split('\n').filter(Boolean).join(' ');
      if (!pids) return resolve();
      exec(`kill -9 ${pids}`, () => setTimeout(resolve, 500));
    });
  });
}

// ── Internal state loop ──────────────────────────────────────────────────────

let lastState = null;
let lastStateJson = null;

async function collectState() {
  // Instances
  const INSTANCES = await getInstances();
  const instances = await Promise.all(
    INSTANCES.map(async (inst) => {
      const up = await checkHealth(inst.port);
      if (up && !uptimeMap[inst.name]) uptimeMap[inst.name] = new Date().toISOString();
      else if (!up) delete uptimeMap[inst.name];
      return { name: inst.name, displayName: inst.displayName || inst.name, id: inst.id, port: inst.port, status: up ? 'up' : 'down', uptimeSince: up ? (uptimeMap[inst.name] || null) : null, model: inst.model || 'haiku', provider: inst.provider || 'anthropic', emoji: inst.emoji || '🤖' };
    })
  );

  // Proxy
  const proxyUp = await checkProxy();
  if (proxyUp && !uptimeMap['proxy']) uptimeMap['proxy'] = new Date().toISOString();
  else if (!proxyUp) delete uptimeMap['proxy'];
  const proxy = {
    status: proxyUp ? 'up' : 'down',
    port: PROXY_PORT,
    uptimeSince: proxyUp ? (uptimeMap['proxy'] || null) : null,
  };

  // Memories
  let memories = [];
  try {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/fleet-api/retrieve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: ORG_ID }), signal: AbortSignal.timeout(5000),
    });
    const d = await r.json();
    memories = Array.isArray(d) ? d : (d.memories || d.data || []);
  } catch { /* proxy may be down */ }

  // Handoffs — all statuses, all agents
  let handoffs = [];
  try {
    const r = await pgPool.query(`
      SELECT h.id, h.status, h.summary, h.next_action,
             h.created_at, h.accepted_at, h.completed_at,
             h.from_agent_id, h.to_agent_id,
             a1.name as from_agent_name, a2.name as to_agent_name
      FROM fleet.handoffs h
      JOIN fleet.agents a1 ON a1.id = h.from_agent_id
      JOIN fleet.agents a2 ON a2.id = h.to_agent_id
      WHERE h.org_id = $1
      ORDER BY h.created_at DESC LIMIT 100
    `, [ORG_ID]);
    handoffs = r.rows;
  } catch { /* db may be unreachable */ }

  // Bindings (direct PG)
  let bindings = [];
  try {
    const result = await pgPool.query(`
      SELECT tb.telegram_id, tb.telegram_username, tb.telegram_name, tb.bound_at, tb.last_seen_at,
             a.email, a.name, a.role, a.department, a.permissions
      FROM fleet.telegram_bindings tb
      JOIN fleet.accounts a ON a.id = tb.account_id
      ORDER BY tb.bound_at DESC
    `);
    bindings = result.rows;
  } catch { /* db may be unreachable */ }

  // Accounts (direct PG)
  let accounts = [];
  try {
    const result = await pgPool.query(`
      SELECT id, name, email, role, department, permissions, is_active
      FROM fleet.accounts
      ORDER BY name
    `);
    accounts = result.rows;
  } catch { /* db may be unreachable */ }

  // Conversations
  let conversations = [];
  try {
    const result = await pgPool.query(`
      SELECT c.id, c.platform_conversation_id, c.title, c.status, c.last_message_at,
             c.platform, c.chat_type, c.channel,
             a.name as agent_name,
             COUNT(m.id)::int as message_count
      FROM fleet.conversations c
      JOIN fleet.agents a ON a.id = c.agent_id
      LEFT JOIN fleet.messages m ON m.conversation_id = c.id
      WHERE c.org_id = $1
      GROUP BY c.id, a.name
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT 50
    `, [ORG_ID]);
    conversations = result.rows;
  } catch { /* db may be unreachable */ }

  // Tasks (summary for WS broadcast)
  let tasks = [];
  try {
    const r = await pgPool.query(`
      SELECT t.id, t.title, t.status, t.priority, t.due_at, t.created_at, a.name as agent_name
      FROM fleet.tasks t
      LEFT JOIN fleet.agents a ON a.id = t.agent_id
      WHERE t.org_id = $1
      ORDER BY t.created_at DESC LIMIT 50
    `, [ORG_ID]);
    tasks = r.rows;
  } catch { /* tasks table may not exist yet */ }

  // Skills
  let skills = [];
  try {
    const r = await pgPool.query(`SELECT id, slug, name, description, category, is_active, instructions, api_endpoint, api_method FROM fleet.skills ORDER BY category, slug`);
    skills = r.rows;
  } catch {}

  return { instances, proxy, memories, handoffs, bindings, accounts, conversations, tasks, skills, updatedAt: new Date().toISOString() };
}

async function stateLoop() {
  try {
    const state = await collectState();
    const stateJson = JSON.stringify(state);
    if (stateJson !== lastStateJson) {
      lastState = state;
      lastStateJson = stateJson;
      broadcast({ type: 'state', data: state });
    }
  } catch (err) {
    console.error('State loop error:', err.message);
    lastStateJson = null; // force retry next tick
  }
}

// Run immediately then every 3 seconds
stateLoop();
setInterval(stateLoop, 3000);

// ── REST endpoints (kept for fleet.sh / curl) ────────────────────────────────

// GET /api/status
app.get('/api/status', async (req, res) => {
  const instances = await getInstances();
  const instanceResults = await Promise.all(
    instances.map(async (inst) => {
      const up = await checkHealth(inst.port);
      if (up && !uptimeMap[inst.name]) uptimeMap[inst.name] = new Date().toISOString();
      else if (!up) delete uptimeMap[inst.name];
      return { name: inst.name, port: inst.port, status: up ? 'up' : 'down', uptimeSince: up ? (uptimeMap[inst.name] || null) : null };
    })
  );

  const proxyUp = await checkProxy();
  if (proxyUp && !uptimeMap['proxy']) uptimeMap['proxy'] = new Date().toISOString();
  else if (!proxyUp) delete uptimeMap['proxy'];

  res.json({
    instances: instanceResults,
    proxy: {
      status: proxyUp ? 'up' : 'down',
      port: PROXY_PORT,
      uptimeSince: proxyUp ? (uptimeMap['proxy'] || null) : null,
    },
  });
});

const SAFE_AGENT_PORT_MIN = 20010;
const SAFE_AGENT_PORT_MAX = 20999;

function isSafeAgentPort(port) {
  return Number.isInteger(port) && port >= SAFE_AGENT_PORT_MIN && port <= SAFE_AGENT_PORT_MAX;
}

// POST /api/restart/:instance — SSE stream with step updates
app.post('/api/restart/:instance', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (d) => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch {} };
  const finish = () => { try { res.end(); } catch {} };

  try {
    const instances = await getInstances();
    const inst = instances.find(i => i.name === req.params.instance);
    if (!inst) { send({ error: 'Agent not found' }); return finish(); }
    if (!isSafeAgentPort(inst.port)) { send({ error: `Unsafe port ${inst.port} — aborting` }); return finish(); }

    send({ step: 1, total: 3, label: `Stopping ${inst.displayName} on :${inst.port}…`, status: 'running' });
    await killPort(inst.port);
    send({ step: 1, label: `Stopped ✓`, status: 'done' });

    send({ step: 2, total: 3, label: 'Starting gateway…', status: 'running' });
    const child = spawn(process.env.OPENCLAW_BIN || '/usr/local/bin/openclaw', ['gateway', 'run', '--port', String(inst.port), '--force'], {
      env: { ...process.env, OPENCLAW_HOME: path.join(os.homedir(), inst.home) },
      detached: true, stdio: 'ignore',
    });
    child.unref();
    fs.writeFileSync(`/tmp/fleet-${inst.name}.pid`, String(child.pid));
    await new Promise(r => setTimeout(r, 2000));
    send({ step: 2, label: 'Gateway started ✓', status: 'done' });

    send({ step: 3, total: 3, label: 'Health check…', status: 'running' });
    let healthy = false;
    for (let i = 0; i < 8; i++) {
      try {
        const h = await fetch(`http://127.0.0.1:${inst.port}/health`, { signal: AbortSignal.timeout(1000) });
        if (h.ok) { healthy = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    send({ step: 3, label: healthy ? 'Agent is up ✓' : 'Started (health timeout)', status: healthy ? 'done' : 'warn' });
    send({ done: true, health: healthy ? 'up' : 'unknown' });
  } catch (err) {
    send({ error: err.message });
  }
  finish();
});

// POST /api/stop/:instance — SSE stream
app.post('/api/stop/:instance', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (d) => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch {} };
  const finish = () => { try { res.end(); } catch {} };

  try {
    const instances = await getInstances();
    const inst = instances.find(i => i.name === req.params.instance);
    if (!inst) { send({ error: 'Agent not found' }); return finish(); }
    if (!isSafeAgentPort(inst.port)) { send({ error: `Unsafe port ${inst.port} — aborting` }); return finish(); }

    send({ step: 1, total: 1, label: `Stopping ${inst.displayName} on :${inst.port}…`, status: 'running' });
    await killPort(inst.port);
    send({ step: 1, label: 'Agent stopped ✓', status: 'done' });
    send({ done: true, health: 'down' });
  } catch (err) {
    send({ error: err.message });
  }
  finish();
});

// POST /api/proxy/restart
app.post('/api/proxy/restart', async (req, res) => {
  await killPort(PROXY_PORT);

  const child = spawn('node', [path.join(os.homedir(), 'oc-fleet/proxy/server.js')], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  res.json({ success: true, message: `Proxy restarting on :${PROXY_PORT}` });
});

// GET /api/accounts
app.get('/api/accounts', async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/fleet-api/accounts/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: ORG_ID }), signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    res.json(Array.isArray(data) ? data : (data.accounts || data.data || []));
  } catch (err) {
    res.status(502).json({ error: 'Proxy unreachable', detail: err.message });
  }
});

// GET /api/accounts/:id/activity — unified activity feed for an account
app.get('/api/accounts/:id/activity', async (req, res) => {
  const { id } = req.params;
  try {
    // Get telegram_id via binding
    const bindR = await pgPool.query(
      `SELECT telegram_id FROM fleet.telegram_bindings WHERE account_id=$1 LIMIT 1`, [id]
    );
    const telegram_id = bindR.rows[0]?.telegram_id || null;

    const [convR, taskR, handoffR, memR] = await Promise.all([
      // Conversations + message count
      telegram_id ? pgPool.query(
        `SELECT c.id, c.platform_conversation_id, c.title, c.status, c.last_message_at, c.platform,
                a.name as agent_name, a.slug as agent_slug,
                COUNT(m.id)::int as message_count,
                SUM(CASE WHEN m.role='user' THEN 1 ELSE 0 END)::int as user_messages,
                SUM(CASE WHEN m.role='assistant' THEN 1 ELSE 0 END)::int as agent_messages
         FROM fleet.conversations c
         JOIN fleet.agents a ON a.id = c.agent_id
         LEFT JOIN fleet.messages m ON m.conversation_id = c.id
         WHERE c.platform_conversation_id = $1
         GROUP BY c.id, a.name, a.slug
         ORDER BY c.last_message_at DESC NULLS LAST LIMIT 20`,
        [telegram_id]
      ) : { rows: [] },
      // Tasks
      pgPool.query(
        `SELECT t.id, t.title, t.description, t.status, t.priority, t.created_at, t.due_at,
                a.name as agent_name
         FROM fleet.tasks t
         LEFT JOIN fleet.agents a ON a.id = t.agent_id
         WHERE t.user_id=$1 AND t.org_id=$2
         ORDER BY t.created_at DESC LIMIT 20`,
        [id, ORG_ID]
      ),
      // Handoffs
      pgPool.query(
        `SELECT h.id, h.status, h.summary, h.next_action, h.created_at, h.accepted_at,
                a1.name as from_agent, a2.name as to_agent
         FROM fleet.handoffs h
         JOIN fleet.agents a1 ON a1.id = h.from_agent_id
         JOIN fleet.agents a2 ON a2.id = h.to_agent_id
         WHERE h.user_id=$1 AND h.org_id=$2
         ORDER BY h.created_at DESC LIMIT 20`,
        [id, ORG_ID]
      ).catch(() => ({ rows: [] })),
      // Memories
      pgPool.query(
        `SELECT m.id, m.content, m.memory_type, m.salience, m.created_at,
                a.name as agent_name
         FROM fleet.memories m
         LEFT JOIN fleet.agents a ON a.id = m.agent_id
         WHERE m.user_id=$1 AND m.org_id=$2
         ORDER BY m.created_at DESC LIMIT 20`,
        [id, ORG_ID]
      ).catch(() => ({ rows: [] })),
    ]);

    res.json({
      conversations: convR.rows,
      tasks: taskR.rows,
      handoffs: handoffR.rows,
      memories: memR.rows,
      stats: {
        conversations: convR.rows.length,
        tasks: taskR.rows.length,
        handoffs: handoffR.rows.length,
        memories: memR.rows.length,
        total_messages: convR.rows.reduce((s, c) => s + (c.message_count||0), 0),
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts/:id/bind — manually bind a Telegram ID to an account
app.post('/api/accounts/:id/bind', async (req, res) => {
  const { id } = req.params;
  const { telegram_id, telegram_username, telegram_name } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
  try {
    // Verify account exists in org
    const acct = await pgPool.query(`SELECT id, name, email FROM fleet.accounts WHERE id=$1 AND org_id=$2`, [id, ORG_ID]);
    if (!acct.rows.length) return res.status(404).json({ error: 'Account not found' });
    await pgPool.query(
      `INSERT INTO fleet.telegram_bindings (org_id, telegram_id, telegram_username, telegram_name, account_id, bound_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
       ON CONFLICT (org_id, telegram_id)
       DO UPDATE SET account_id=$5, telegram_username=$3, telegram_name=$4, bound_at=NOW()`,
      [ORG_ID, String(telegram_id), telegram_username||null, telegram_name||null, id]
    );
    res.json({ ok: true, account: acct.rows[0], telegram_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/accounts/:id/bind — remove binding
app.delete('/api/accounts/:id/bind', async (req, res) => {
  const { id } = req.params;
  try {
    await pgPool.query(`DELETE FROM fleet.telegram_bindings WHERE account_id=$1 AND org_id=$2`, [id, ORG_ID]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/accounts/:id/otp — latest pending OTP for this account
app.get('/api/accounts/:id/otp', async (req, res) => {
  const { id } = req.params;
  try {
    const r = await pgPool.query(`
      SELECT otp_code, expires_at, attempts_remaining, created_at
      FROM fleet.otp_verifications
      WHERE email = (SELECT email FROM fleet.accounts WHERE id = $1)
        AND org_id = $2
        AND verified_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `, [id, ORG_ID]);
    if (!r.rows.length) return res.json({ found: false });
    res.json({ found: true, ...r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts/:id/generate-otp — generate OTP via proxy then return it
app.post('/api/accounts/:id/generate-otp', async (req, res) => {
  const { id } = req.params;
  try {
    const acct = await pgPool.query(`SELECT email FROM fleet.accounts WHERE id=$1 AND org_id=$2`, [id, ORG_ID]);
    if (!acct.rows.length) return res.status(404).json({ error: 'Account not found' });
    const { email } = acct.rows[0];
    await fetch(`http://127.0.0.1:${PROXY_PORT}/fleet-api/pairing/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: ORG_ID, telegram_id: 'admin-generated', telegram_name: 'Admin', email }),
      signal: AbortSignal.timeout(10000),
    });
    const otp = await pgPool.query(`
      SELECT otp_code, expires_at, attempts_remaining, created_at
      FROM fleet.otp_verifications
      WHERE email = $1 AND org_id = $2 AND verified_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `, [email, ORG_ID]);
    if (!otp.rows.length) return res.json({ ok: true, found: false });
    res.json({ ok: true, found: true, ...otp.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/bindings — with OTP status
app.get('/api/bindings', async (req, res) => {
  try {
    const result = await pgPool.query(`
      SELECT tb.telegram_id, tb.telegram_username, tb.telegram_name, tb.bound_at, tb.last_seen_at,
             a.email, a.name, a.role, a.department, a.permissions
      FROM fleet.telegram_bindings tb
      JOIN fleet.accounts a ON a.id = tb.account_id
      ORDER BY tb.bound_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// GET /api/otp-status — all OTP verifications with status
app.get('/api/otp-status', async (req, res) => {
  try {
    const result = await pgPool.query(`
      SELECT o.id, o.telegram_id, o.email, o.otp_code, o.attempts,
             o.verified, o.expires_at, o.created_at,
             CASE
               WHEN o.verified = true THEN 'completed'
               WHEN o.attempts >= 3 THEN 'denied'
               WHEN o.expires_at < now() THEN 'expired'
               ELSE 'pending'
             END as status,
             a.name as account_name, a.role, a.department
      FROM fleet.otp_verifications o
      LEFT JOIN fleet.accounts a ON LOWER(a.email) = LOWER(o.email) AND a.org_id = o.org_id
      ORDER BY o.created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// GET /api/memories
app.get('/api/memories', async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/fleet-api/retrieve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: ORG_ID }), signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Proxy unreachable', detail: err.message });
  }
});

// GET /api/handoffs — all statuses, all agents
app.get('/api/handoffs', async (req, res) => {
  try {
    const result = await pgPool.query(`
      SELECT h.id, h.status, h.summary, h.next_action, h.risks,
             h.created_at, h.accepted_at, h.completed_at,
             h.from_agent_id, h.to_agent_id,
             a1.name as from_agent_name, a1.slug as from_agent_slug,
             a2.name as to_agent_name, a2.slug as to_agent_slug
      FROM fleet.handoffs h
      JOIN fleet.agents a1 ON a1.id = h.from_agent_id
      JOIN fleet.agents a2 ON a2.id = h.to_agent_id
      WHERE h.org_id = $1
      ORDER BY h.created_at DESC
      LIMIT 100
    `, [ORG_ID]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// GET /api/skills
app.get('/api/skills', async (req, res) => {
  try {
    const result = await pgPool.query(
      `SELECT id, slug, name, description, category, is_active, api_endpoint, api_method, instructions
       FROM fleet.skills ORDER BY category, slug`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/skills — create
app.post('/api/skills', async (req, res) => {
  const { slug, name, description, category, api_endpoint, api_method, instructions, is_active } = req.body;
  if (!slug || !name) return res.status(400).json({ error: 'slug and name required' });
  try {
    const r = await pgPool.query(
      `INSERT INTO fleet.skills (slug, name, description, category, api_endpoint, api_method, instructions, is_active, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'1.0') RETURNING id`,
      [slug, name, description||null, category||null, api_endpoint||null, api_method||'POST', instructions||null, is_active!==false]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/skills/:id — update
app.patch('/api/skills/:id', async (req, res) => {
  const fields = ['name','description','category','api_endpoint','api_method','instructions','is_active'];
  const updates = []; const vals = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f}=$${vals.length+1}`); vals.push(req.body[f]); } });
  if (!updates.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  try {
    await pgPool.query(`UPDATE fleet.skills SET ${updates.join(',')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/skills/:id — soft delete (deactivate) or hard delete
app.delete('/api/skills/:id', async (req, res) => {
  const hard = req.query.hard === 'true';
  try {
    if (hard) {
      await pgPool.query('DELETE FROM fleet.skills WHERE id=$1', [req.params.id]);
    } else {
      await pgPool.query('UPDATE fleet.skills SET is_active=false WHERE id=$1', [req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/skills/:id/assign — assign skill to agent
app.post('/api/skills/:id/assign', async (req, res) => {
  const { agent_id, enabled } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  try {
    await pgPool.query(
      `INSERT INTO fleet.agent_skill_assignments (agent_id, skill_id, tenant_id, enabled, source)
       VALUES ($1,$2,$3,$4,'manual')
       ON CONFLICT (agent_id, skill_id) DO UPDATE SET enabled=$4`,
      [agent_id, req.params.id, ORG_ID, enabled !== false]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/skills/:id/assign/:agent_id — unassign skill from agent
app.delete('/api/skills/:id/assign/:agent_id', async (req, res) => {
  try {
    await pgPool.query(
      'DELETE FROM fleet.agent_skill_assignments WHERE skill_id=$1 AND agent_id=$2',
      [req.params.id, req.params.agent_id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/skills/:id/callbacks
app.get('/api/skills/:id/callbacks', async (req, res) => {
  try {
    const r = await pgPool.query(
      `SELECT id, name, endpoint, method, auth_type, auth_secret, headers, timeout_ms, retry_count, is_active, environment
       FROM fleet.skill_callbacks WHERE skill_id=$1 AND org_id=$2 ORDER BY name`,
      [req.params.id, ORG_ID]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/skills/:id/callbacks — upsert a callback
app.post('/api/skills/:id/callbacks', async (req, res) => {
  const { name='default', endpoint, method='POST', auth_type='none', auth_secret, headers, timeout_ms=30000, retry_count=0, is_active=true, environment='all' } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  try {
    const r = await pgPool.query(
      `INSERT INTO fleet.skill_callbacks (skill_id, org_id, name, endpoint, method, auth_type, auth_secret, headers, timeout_ms, retry_count, is_active, environment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (skill_id, org_id, name, environment)
       DO UPDATE SET endpoint=$4, method=$5, auth_type=$6, auth_secret=$7, headers=$8, timeout_ms=$9, retry_count=$10, is_active=$11
       RETURNING id`,
      [req.params.id, ORG_ID, name, endpoint, method, auth_type, auth_secret||null, JSON.stringify(headers||{}), timeout_ms, retry_count, is_active, environment]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/skills/callbacks/:callback_id
app.delete('/api/skills/callbacks/:callback_id', async (req, res) => {
  try {
    await pgPool.query('DELETE FROM fleet.skill_callbacks WHERE id=$1 AND org_id=$2', [req.params.callback_id, ORG_ID]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/skills/:id/details
app.get('/api/skills/:id/details', async (req, res) => {
  try {
    const [skill, depts, roles, agents, callbacks] = await Promise.all([
      pgPool.query(`SELECT id, slug, name, description, category, is_active, instructions, api_endpoint, api_method, request_schema, response_schema FROM fleet.skills WHERE id=$1`, [req.params.id]),
      pgPool.query(`SELECT dsp.department, dsp.is_required, dsp.can_disable FROM fleet.department_skill_presets dsp WHERE dsp.skill_id=$1 AND dsp.tenant_id=$2 ORDER BY dsp.department`, [req.params.id, ORG_ID]),
      pgPool.query(`SELECT srp.department, srp.user_role, srp.can_use, srp.can_configure, srp.can_install, srp.can_remove FROM fleet.skill_role_permissions srp WHERE srp.skill_id=$1 AND srp.tenant_id=$2 ORDER BY srp.department, srp.user_role`, [req.params.id, ORG_ID]),
      pgPool.query(`SELECT a.name, a.slug, asa.enabled, asa.source FROM fleet.agent_skill_assignments asa JOIN fleet.agents a ON a.id=asa.agent_id WHERE asa.skill_id=$1 AND asa.tenant_id=$2`, [req.params.id, ORG_ID]).catch(() => ({ rows: [] })),
      pgPool.query(`SELECT sc.id, sc.name, sc.endpoint, sc.method, sc.auth_type, sc.headers, sc.timeout_ms, sc.retry_count, sc.is_active, sc.environment, sc.transform_request FROM fleet.skill_callbacks sc WHERE sc.skill_id=$1 AND sc.org_id=$2 ORDER BY sc.name`, [req.params.id, ORG_ID]).catch(() => ({ rows: [] })),
    ]);
    const s = skill.rows[0] || {};
    res.json({ ...s, departments: depts.rows, roles: roles.rows, agents: agents.rows, callbacks: callbacks.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/skills/:id/test — invoke skill callback with test params
app.post('/api/skills/:id/test', async (req, res) => {
  try {
    const { callback_name = 'default', params = {} } = req.body;
    const cb = await pgPool.query(
      `SELECT sc.endpoint, sc.method, sc.headers, sc.auth_type, sc.auth_secret, sc.timeout_ms
       FROM fleet.skill_callbacks sc WHERE sc.skill_id=$1 AND sc.org_id=$2 AND sc.name=$3 AND sc.is_active=true LIMIT 1`,
      [req.params.id, ORG_ID, callback_name]
    );
    if (!cb.rows.length) return res.json({ success: false, error: 'No active callback found' });
    const c = cb.rows[0];
    if (!['POST','GET','PUT','PATCH'].includes(c.method)) {
      return res.json({ success: false, error: `Method ${c.method} requires server-side execution (EXEC/SQL)`, endpoint: c.endpoint, note: 'Cannot invoke directly from dashboard — must be run on the agent host.' });
    }
    const body = JSON.stringify(params);
    const headers = { 'Content-Type': 'application/json', ...(c.headers || {}) };
    if (c.auth_type === 'bearer' && c.auth_secret) headers['Authorization'] = `Bearer ${c.auth_secret}`;
    const start = Date.now();
    const r = await fetch(c.endpoint, { method: c.method, headers, body: ['GET'].includes(c.method) ? undefined : body, timeout: c.timeout_ms || 10000 });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.json({ success: r.ok, status: r.status, data, duration_ms: Date.now() - start, endpoint: c.endpoint, method: c.method });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET /api/skills/resolve/:telegram_id (by telegram_id)
app.get('/api/skills/resolve/:telegram_id', async (req, res) => {
  try {
    const bindR = await pgPool.query(
      `SELECT account_id FROM fleet.telegram_bindings WHERE telegram_id=$1`, [req.params.telegram_id]
    );
    if (!bindR.rows.length) return res.json({ skills: [] });
    const r = await pgPool.query(
      `SELECT slug, name, description, category, source, can_use, can_configure FROM fleet.resolve_skills($1, $2)`,
      [ORG_ID, bindR.rows[0].account_id]
    );
    res.json({ skills: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/skills/resolve/account/:account_id (by account UUID — all 523 users)
app.get('/api/skills/resolve/account/:account_id', async (req, res) => {
  try {
    const r = await pgPool.query(
      `SELECT slug, name, description, category, source, can_use, can_configure FROM fleet.resolve_skills($1, $2)`,
      [ORG_ID, req.params.account_id]
    );
    // Also get account info
    const acct = await pgPool.query(`SELECT name, email, role, department FROM fleet.accounts WHERE id=$1`, [req.params.account_id]);
    res.json({ skills: r.rows, account: acct.rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/group-chats
app.get('/api/group-chats', async (req, res) => {
  try {
    const result = await pgPool.query(
      `SELECT id, name, platform_group_id FROM fleet.group_chats WHERE org_id = $1 ORDER BY name`,
      [ORG_ID]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// POST /api/orchestrate/send
app.post('/api/orchestrate/send', async (req, res) => {
  const { user_telegram_id, agent_name, chat_type, group_chat_id, message } = req.body;
  if (!user_telegram_id || !agent_name || !chat_type || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const agent_id = AGENT_IDS[agent_name];
  if (!agent_id) {
    return res.status(400).json({ error: 'Unknown agent name' });
  }

  const platform_conversation_id = chat_type === 'gc' ? group_chat_id : String(user_telegram_id);

  let telegram_name = 'Unknown User';
  try {
    const r = await pgPool.query(
      `SELECT tb.telegram_name FROM fleet.telegram_bindings tb
       JOIN fleet.accounts a ON a.id = tb.account_id
       WHERE tb.telegram_id = $1`,
      [String(user_telegram_id)]
    );
    if (r.rows.length) telegram_name = r.rows[0].telegram_name || 'Unknown User';
  } catch { /* fallback to Unknown User */ }

  try {
    // 1. Log user message to DB
    const logRes = await fetch(`http://127.0.0.1:${PROXY_PORT}/fleet-api/conversation/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_id: ORG_ID, agent_id,
        telegram_id: String(user_telegram_id), telegram_name,
        chat_type, platform_conversation_id,
        role: 'user', content: message,
      }), signal: AbortSignal.timeout(10000),
    });
    const logData = await logRes.json();

    // 2. Send to OC gateway and get agent reply
    const agentKey = agent_name.toLowerCase();
    const orchInstances = await getInstances();
    const orchInst = orchInstances.find(i => i.name === agentKey);
    const port = orchInst?.port;
    const home = orchInst ? path.join(os.homedir(), orchInst.home) : null;

    let agentReply = null;
    if (port && home) {
      try {
        const result = await new Promise((resolve, reject) => {
          const proc = spawn('openclaw', [
            'agent',
            '--message', message,
            '--session-id', `orchestration-${user_telegram_id}`,
          ], {
            env: { ...process.env, OPENCLAW_HOME: home }, signal: AbortSignal.timeout(60000),
          });
          let out = '';
          let err = '';
          proc.stdout.on('data', d => out += d);
          // stderr has debug logs — filter to last non-empty line that isn't a log
          proc.stderr.on('data', d => err += d);
          proc.on('close', code => {
            // stdout has the plain text reply
            const text = out.trim();
            if (text) return resolve({ payloads: [{ text }] });
            // fallback: parse stderr for the actual reply (after log lines)
            const lines = err.split('\n').filter(l => l.trim() && !l.startsWith('[') && !l.startsWith('Gateway') && !l.startsWith('Source') && !l.startsWith('Config') && !l.startsWith('Bind'));
            resolve({ payloads: [{ text: lines.join('\n').trim() }] });
          });
          proc.on('error', reject);
        });
        agentReply = result?.payloads?.[0]?.text || result?.text || result?.reply || result?.content || null;
      } catch (e) {
        console.error('[orchestrate] gateway call failed:', e.message);
      }
    }

    // 3. Log agent reply to DB if we got one
    if (agentReply) {
      await fetch(`http://127.0.0.1:${PROXY_PORT}/fleet-api/conversation/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: ORG_ID, agent_id,
          telegram_id: String(user_telegram_id), telegram_name,
          chat_type, platform_conversation_id,
          role: 'assistant', content: agentReply,
        }), signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    }

    res.json({
      success: true,
      conversation_id: logData.conversation_id,
      message_id: logData.message_id,
      agent_reply: agentReply,
    });
  } catch (err) {
    res.status(502).json({ error: 'Failed', detail: err.message });
  }
});

// GET /api/tasks
app.get('/api/tasks', async (req, res) => {
  try {
    const result = await pgPool.query(`
      SELECT t.id, t.title, t.description, t.status, t.priority,
             t.due_at, t.started_at, t.completed_at, t.tags,
             t.created_at, t.updated_at,
             a.name as agent_name,
             c.title as conversation_title
      FROM fleet.tasks t
      LEFT JOIN fleet.agents a ON a.id = t.agent_id
      LEFT JOIN fleet.conversations c ON c.id = t.source_conversation_id
      WHERE t.org_id = $1
      ORDER BY
        CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        t.due_at ASC NULLS LAST, t.created_at DESC
      LIMIT 200
    `, [ORG_ID]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// POST /api/tasks
app.post('/api/tasks', async (req, res) => {
  const { title, description, status = 'pending', priority = 'normal', due_at, agent_name, tags } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  try {
    let agent_id = null;
    if (agent_name) {
      const ar = await pgPool.query(`SELECT id FROM fleet.agents WHERE org_id = $1 AND name ILIKE $2 LIMIT 1`, [ORG_ID, agent_name]);
      if (ar.rows.length) agent_id = ar.rows[0].id;
    }
    const result = await pgPool.query(`
      INSERT INTO fleet.tasks (org_id, title, description, status, priority, due_at, agent_id, tags)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [ORG_ID, title, description || null, status, priority, due_at || null, agent_id, tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : []]);
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// PATCH /api/tasks/:id
app.patch('/api/tasks/:id', async (req, res) => {
  const { status, priority, due_at, title, description } = req.body;
  const fields = [];
  const vals = [];
  let idx = 1;
  if (status !== undefined)      { fields.push(`status = $${idx++}`);      vals.push(status); }
  if (priority !== undefined)    { fields.push(`priority = $${idx++}`);    vals.push(priority); }
  if (due_at !== undefined)      { fields.push(`due_at = $${idx++}`);      vals.push(due_at || null); }
  if (title !== undefined)       { fields.push(`title = $${idx++}`);       vals.push(title); }
  if (description !== undefined) { fields.push(`description = $${idx++}`); vals.push(description); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  fields.push(`updated_at = now()`);
  if (status === 'in_progress') fields.push(`started_at = COALESCE(started_at, now())`);
  if (status === 'done' || status === 'cancelled') fields.push(`completed_at = COALESCE(completed_at, now())`);
  vals.push(req.params.id, ORG_ID);
  try {
    await pgPool.query(`UPDATE fleet.tasks SET ${fields.join(', ')} WHERE id = $${idx++} AND org_id = $${idx}`, vals);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// DELETE /api/tasks/:id
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    await pgPool.query(`DELETE FROM fleet.tasks WHERE id = $1 AND org_id = $2`, [req.params.id, ORG_ID]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// GET /api/memory-stats
app.get('/api/memory-stats', async (req, res) => {
  try {
    const byType = await pgPool.query(`
      SELECT memory_type, COUNT(*) as count, ROUND(AVG(salience)::numeric, 2) as avg_salience
      FROM fleet.memories WHERE org_id = $1
      GROUP BY memory_type ORDER BY count DESC
    `, [ORG_ID]);
    const byAgent = await pgPool.query(`
      SELECT COALESCE(a.name, 'Unknown') as agent_name, COUNT(m.id) as count,
             ROUND(AVG(m.salience)::numeric, 2) as avg_salience
      FROM fleet.memories m
      LEFT JOIN fleet.agents a ON a.id = m.agent_id
      WHERE m.org_id = $1
      GROUP BY a.name ORDER BY count DESC
    `, [ORG_ID]);
    const total = byType.rows.reduce((s, r) => s + parseInt(r.count), 0);
    res.json({ byType: byType.rows, byAgent: byAgent.rows, total });
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// GET /api/conversations
app.get('/api/conversations', async (req, res) => {
  try {
    const result = await pgPool.query(`
      SELECT c.id, c.platform_conversation_id, c.title, c.status, c.last_message_at,
             c.platform, c.chat_type, c.channel,
             a.name as agent_name,
             COUNT(m.id)::int as message_count
      FROM fleet.conversations c
      JOIN fleet.agents a ON a.id = c.agent_id
      LEFT JOIN fleet.messages m ON m.conversation_id = c.id
      WHERE c.org_id = $1
      GROUP BY c.id, a.name
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT 50
    `, [ORG_ID]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// GET /api/conversations/:id/messages
app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const result = await pgPool.query(
      `SELECT id, role, content, created_at FROM fleet.messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// GET /api/agent-configs — fully dynamic from DB
app.get('/api/agent-configs', async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      `SELECT id, slug FROM fleet.agents WHERE org_id=$1 AND status='active'`,
      [ORG_ID]
    );
    const result = {};
    await Promise.all(
      rows.map(async ({ id: agent_id, slug }) => {
        try {
          const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/fleet-api/agent/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_id }),
            signal: AbortSignal.timeout(5000),
          });
          const d = await r.json();
          result[slug] = d.config || d;
        } catch {
          result[slug] = {};
        }
      })
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent-configs/:agent_id
app.post('/api/agent-configs/:agent_id', async (req, res) => {
  const { agent_id } = req.params;
  const { system_prompt, skill_map, behaviors } = req.body;
  try {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/fleet-api/agent/config/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id, system_prompt, skill_map, behaviors }), signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    res.json({ success: r.ok, ...data });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// POST /api/sync-sessions
app.post('/api/sync-sessions', (req, res) => {
  const child = spawn('node', [path.join(os.homedir(), 'oc-fleet/scripts/sync-sessions.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  child.on('close', code => {
    res.json({ success: code === 0, message: output.trim() || (code === 0 ? 'Sync complete' : 'Sync failed') });
  });
  child.on('error', err => {
    res.status(500).json({ success: false, message: err.message });
  });
});

// ── Knowledge helpers ────────────────────────────────────────────────────────

async function resyncMemory(memoryId, content) {
  const chunks = chunkText(content);
  const vectors = await embedTexts(chunks, GEMINI_API_KEY);
  let chunks_added = 0;
  let embeddings_added = 0;

  for (let i = 0; i < chunks.length; i++) {
    const tokenCount = Math.ceil(chunks[i].length / 4);
    let chunkId;

    const existing = await pgPool.query(
      `SELECT id FROM fleet.memory_chunks WHERE memory_id = $1 AND chunk_index = $2`,
      [memoryId, i]
    );
    if (existing.rows.length) {
      chunkId = existing.rows[0].id;
    } else {
      const chunkR = await pgPool.query(
        `INSERT INTO fleet.memory_chunks (memory_id, chunk_index, content, token_count) VALUES ($1, $2, $3, $4) RETURNING id`,
        [memoryId, i, chunks[i], tokenCount]
      );
      chunkId = chunkR.rows[0].id;
      chunks_added++;
    }

    const embExists = await pgPool.query(
      `SELECT id FROM fleet.memory_embeddings WHERE chunk_id = $1`,
      [chunkId]
    );
    if (!embExists.rows.length) {
      const embeddingStr = '[' + vectors[i].join(',') + ']';
      await pgPool.query(
        `INSERT INTO fleet.memory_embeddings (chunk_id, embedding, embedding_model) VALUES ($1, $2::vector, $3)`,
        [chunkId, embeddingStr, 'gemini-embedding-2-preview']
      );
      embeddings_added++;
    }
  }

  return { chunks_added, embeddings_added };
}

// GET /api/knowledge
app.get('/api/knowledge', async (req, res) => {
  try {
    const result = await pgPool.query(`
      WITH domain_counts AS (
        SELECT summary, org_id, COUNT(*) AS total
        FROM fleet.memories
        WHERE memory_type = 'knowledge' AND deleted_at IS NULL AND org_id = $1
        GROUP BY summary, org_id
      )
      SELECT
        m.id,
        m.summary AS domain,
        m.content,
        m.salience,
        m.visibility,
        m.source_type,
        m.agent_id,
        COALESCE(a.name, 'org') AS agent_name,
        m.created_at,
        m.updated_at,
        COUNT(DISTINCT mc.id) AS chunk_count,
        COUNT(DISTINCT me.id) AS embedding_count,
        LENGTH(m.content) AS content_size,
        GREATEST(0, dc.total - 1) AS duplicate_count
      FROM fleet.memories m
      LEFT JOIN fleet.memory_chunks mc ON mc.memory_id = m.id
      LEFT JOIN fleet.memory_embeddings me ON me.chunk_id = mc.id
      LEFT JOIN domain_counts dc ON dc.summary = m.summary AND dc.org_id = m.org_id
      LEFT JOIN fleet.agents a ON a.id = m.agent_id
      WHERE m.memory_type = 'knowledge' AND m.deleted_at IS NULL AND m.org_id = $1
        AND m.visibility IN ('org', 'department')
      GROUP BY m.id, dc.total, a.name
      ORDER BY m.created_at DESC
    `, [ORG_ID]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// POST /api/knowledge/bulk-resync  (must be before /:id route)
app.post('/api/knowledge/bulk-resync', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const { ids } = req.body || {};
    let memories;

    if (ids && ids.length > 0) {
      const r = await pgPool.query(
        `SELECT m.id, m.summary, m.content
         FROM fleet.memories m
         WHERE m.id = ANY($1) AND m.org_id = $2 AND m.deleted_at IS NULL`,
        [ids, ORG_ID]
      );
      memories = r.rows;
    } else {
      const r = await pgPool.query(`
        SELECT m.id, m.summary, m.content
        FROM fleet.memories m
        LEFT JOIN fleet.memory_chunks mc ON mc.memory_id = m.id
        LEFT JOIN fleet.memory_embeddings me ON me.chunk_id = mc.id
        WHERE m.memory_type = 'knowledge' AND m.deleted_at IS NULL AND m.org_id = $1
        GROUP BY m.id, m.summary, m.content
        HAVING COUNT(DISTINCT me.id) = 0
      `, [ORG_ID]);
      memories = r.rows;
    }

    const total = memories.length;
    send({ type: 'start', total });

    let success = 0, failed = 0;
    for (let i = 0; i < memories.length; i++) {
      const m = memories[i];
      try {
        const result = await resyncMemory(m.id, m.content);
        send({ type: 'progress', current: i + 1, total, id: m.id, domain: m.summary, status: 'ok', chunks: result.chunks_added, embeddings: result.embeddings_added });
        success++;
      } catch (e) {
        send({ type: 'progress', current: i + 1, total, id: m.id, domain: m.summary, status: 'error', error: e.message });
        failed++;
      }
    }

    send({ type: 'done', total, success, failed });
  } catch (err) {
    send({ type: 'error', error: err.message });
  }
  res.end();
});

// POST /api/knowledge/:id/resync
app.post('/api/knowledge/:id/resync', async (req, res) => {
  try {
    const { id } = req.params;
    const mr = await pgPool.query(
      `SELECT id, content FROM fleet.memories WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [id, ORG_ID]
    );
    if (!mr.rows.length) return res.status(404).json({ error: 'Memory not found' });
    const result = await resyncMemory(id, mr.rows[0].content);
    res.json({ success: true, memory_id: id, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge/dedup-scan
app.post('/api/knowledge/dedup-scan', async (req, res) => {
  try {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/fleet-api/memory/dedup-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: ORG_ID, memory_type: 'knowledge', threshold_auto: 0.92, threshold_review: 0.85, limit: 500 }), signal: AbortSignal.timeout(30000),
    });
    const data = await r.json();
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Proxy unreachable', detail: err.message });
  }
});

// GET /api/knowledge/dedup-queue
app.get('/api/knowledge/dedup-queue', async (req, res) => {
  try {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/fleet-api/memory/dedup-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: ORG_ID, status: 'pending' }), signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    res.status(r.ok ? 200 : r.status).json({ queue: data.queue || data.data || [], total: data.total || 0 });
  } catch (err) {
    res.status(502).json({ error: 'Proxy unreachable', detail: err.message });
  }
});

// POST /api/knowledge/dedup-merge
app.post('/api/knowledge/dedup-merge', async (req, res) => {
  const { queue_id, winner_id } = req.body || {};
  if (!queue_id || !winner_id) return res.status(400).json({ error: 'Missing queue_id or winner_id' });
  try {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/fleet-api/memory/dedup-merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue_id, winner_id, org_id: ORG_ID }), signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Proxy unreachable', detail: err.message });
  }
});

// POST /api/knowledge/dedup-skip
app.post('/api/knowledge/dedup-skip', async (req, res) => {
  const { queue_id } = req.body || {};
  if (!queue_id) return res.status(400).json({ error: 'Missing queue_id' });
  try {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/fleet-api/memory/dedup-skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue_id, org_id: ORG_ID }), signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Proxy unreachable', detail: err.message });
  }
});

// GET /api/agents — list all fleet agents with health status
// POST /api/agents/spawn — SSE endpoint that spawns a new agent
app.post('/api/agents/spawn', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const TOTAL = 9;

  try {
    const { name, slug, description, department, bot_token, model, skills } = req.body || {};

    // Step 1: Validate inputs
    send({ step: 1, total: TOTAL, label: 'Validating inputs...', status: 'running' });
    if (!name || !slug || !description || !bot_token) {
      send({ error: 'name, slug, description, and bot_token are required' });
      return res.end();
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      send({ error: 'Slug must be lowercase alphanumeric with hyphens only' });
      return res.end();
    }
    send({ step: 1, total: TOTAL, label: 'Validating inputs...', status: 'done' });

    // Step 2: Assign port + agent ID
    send({ step: 2, total: TOTAL, label: 'Assigning port + agent ID...', status: 'running' });
    const existingR = await pgPool.query(`SELECT slug FROM fleet.agents WHERE org_id = $1`, [ORG_ID]);
    const existingSlugs = existingR.rows.map(r => r.slug);
    const KNOWN_PORTS = { sales: 20010, support: 20020, manager: 20030, dev: 20040, it: 20050 };
    const usedPorts = new Set(Object.values(KNOWN_PORTS));
    // Collect ports from PID meta files for dynamic agents
    for (const s of existingSlugs) {
      try {
        const pf = `/tmp/fleet-${s}.pid.meta`;
        if (fs.existsSync(pf)) {
          const meta = JSON.parse(fs.readFileSync(pf, 'utf8'));
          if (meta.port) usedPorts.add(meta.port);
        }
      } catch {}
    }
    // Find next available port in 20060, 20070, 20080... series
    let assignedPort = null;
    for (let p = 20060; p <= 20990; p += 10) {
      if (usedPorts.has(p)) continue;
      const free = await new Promise(resolve => {
        exec(`lsof -ti :${p}`, (err, stdout) => resolve(!stdout || !stdout.trim()));
      });
      if (free) { assignedPort = p; break; }
    }
    if (!assignedPort) {
      send({ error: 'No available port found in range 20060-20990' });
      return res.end();
    }
    const agentId = crypto.randomUUID();
    send({ step: 2, total: TOTAL, label: `Assigned port ${assignedPort}, ID ${agentId}`, status: 'done' });

    // Step 3: Generate gateway auth token
    send({ step: 3, total: TOTAL, label: 'Generating gateway auth token...', status: 'running' });
    const gatewayToken = crypto.randomBytes(32).toString('hex');
    send({ step: 3, total: TOTAL, label: 'Gateway auth token generated', status: 'done' });

    // Step 4: Insert into fleet.agents
    send({ step: 4, total: TOTAL, label: 'Registering agent in database...', status: 'running' });
    await pgPool.query(
      `INSERT INTO fleet.agents (id, name, slug, org_id) VALUES ($1, $2, $3, $4)`,
      [agentId, name, slug, ORG_ID]
    );
    send({ step: 4, total: TOTAL, label: 'Agent registered in database', status: 'done' });

    // Step 5: Generate system prompt via Anthropic API
    send({ step: 5, total: TOTAL, label: 'Generating system prompt with AI...', status: 'running' });
    let systemPrompt = `You are ${name}, a fleet AI agent${department ? ` in the ${department} department` : ''}. ${description}`;
    try {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `You are generating a system prompt for a fleet AI agent named ${name}. Description: ${description}. Department: ${department || 'general'}. Generate a concise, professional system prompt (max 300 words) that defines this agent role, what it handles, and when to hand off to other agents. Output ONLY the system prompt text, no explanation.`,
          }],
        }),
      });
      if (anthropicRes.ok) {
        const ad = await anthropicRes.json();
        systemPrompt = ad.content?.[0]?.text || systemPrompt;
      }
    } catch {}
    send({ step: 5, total: TOTAL, label: 'System prompt generated', status: 'done' });

    // Step 6: Insert into fleet.agent_configs
    send({ step: 6, total: TOTAL, label: 'Saving agent configuration...', status: 'running' });
    await pgPool.query(
      `INSERT INTO fleet.agent_configs (agent_id, org_id, version, is_active, system_prompt) VALUES ($1, $2, 1, true, $3)
       ON CONFLICT DO NOTHING`,
      [agentId, ORG_ID, systemPrompt]
    );

    // Step 7: Assign skills by copying from closest matching existing agent
    if (department) {
      try {
        const refAgent = await pgPool.query(
          `SELECT a.id FROM fleet.agents a
           JOIN fleet.agent_skill_assignments asa ON asa.agent_id = a.id
           WHERE a.org_id = $1 AND a.slug != $2
           GROUP BY a.id LIMIT 1`,
          [ORG_ID, slug]
        );
        if (refAgent.rows.length) {
          const refId = refAgent.rows[0].id;
          await pgPool.query(
            `INSERT INTO fleet.agent_skill_assignments (agent_id, skill_id, tenant_id, enabled, source)
             SELECT $1, asa.skill_id, asa.tenant_id, asa.enabled, 'inherited'
             FROM fleet.agent_skill_assignments asa WHERE asa.agent_id = $2
             ON CONFLICT DO NOTHING`,
            [agentId, refId]
          );
        }
      } catch {}
    }
    send({ step: 6, total: TOTAL, label: 'Agent configuration saved', status: 'done' });

    // Step 7: Create directory structure
    send({ step: 7, total: TOTAL, label: 'Creating agent workspace...', status: 'running' });
    const agentHome = path.join(os.homedir(), `cbfleet-rag-${slug}`);
    const agentDir = path.join(agentHome, '.openclaw', 'agents', 'main', 'agent');
    const workspaceDir = path.join(agentHome, '.openclaw', 'workspace', 'memory');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    // Write openclaw.json (based on sales template)
    const openclawConfig = {
      gateway: {
        port: assignedPort,
        mode: 'local',
        bind: 'loopback',
        auth: { mode: 'token', token: gatewayToken },
      },
      auth: {
        profiles: { 'anthropic:default': { provider: 'anthropic', mode: 'token' } },
      },
      agents: {
        list: [{ id: 'main', name, model: model || 'claude-haiku-4-5-20251001' }],
        defaults: { timeoutSeconds: 300 },
      },
      tools: { exec: { host: 'gateway', security: 'full', ask: 'off' } },
      channels: {
        telegram: {
          enabled: true,
          dmPolicy: 'open',
          allowFrom: ['*'],
          groupPolicy: 'open',
          streaming: 'partial',
          defaultAccount: 'default',
          accounts: {
            default: {
              botToken: bot_token,
              dmPolicy: 'open',
              allowFrom: ['*'],
              groups: { '*': { requireMention: false } },
              streaming: 'partial',
              actions: { reactions: true },
            },
          },
        },
      },
      session: { dmScope: 'main' },
    };
    fs.writeFileSync(
      path.join(agentHome, '.openclaw', 'openclaw.json'),
      JSON.stringify(openclawConfig, null, 2)
    );

    // Copy auth-profiles.json from sales instance
    try {
      const salesAuthProfiles = path.join(os.homedir(), 'cbfleet-rag-sales', '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
      if (fs.existsSync(salesAuthProfiles)) {
        fs.copyFileSync(salesAuthProfiles, path.join(agentDir, 'auth-profiles.json'));
      }
    } catch {}

    // Write SOUL.md
    const proxyUrl = `http://127.0.0.1:${PROXY_PORT}`;
    fs.writeFileSync(
      path.join(agentHome, '.openclaw', 'workspace', 'SOUL.md'),
      `# ${name}\n\nAgent ID: ${agentId}\nProxy URL: ${proxyUrl}\nPort: ${assignedPort}\n\nFetch full configuration from the database using your agent_id.\n`
    );
    send({ step: 7, total: TOTAL, label: 'Agent workspace created', status: 'done' });

    // Step 8: Start the instance
    send({ step: 8, total: TOTAL, label: `Starting agent on port ${assignedPort}...`, status: 'running' });
    const child = spawn(
      process.env.OPENCLAW_BIN || '/usr/local/bin/openclaw',
      ['gateway', 'run', '--port', String(assignedPort), '--force'],
      {
        env: { ...process.env, OPENCLAW_HOME: agentHome },
        detached: true,
        stdio: 'ignore',
      }
    );
    child.unref();
    send({ step: 8, total: TOTAL, label: 'Agent process started', status: 'done' });

    // Step 9: Health check
    send({ step: 9, total: TOTAL, label: 'Waiting for health check...', status: 'running' });
    let healthy = false;
    const healthStart = Date.now();
    while (Date.now() - healthStart < 15000) {
      await new Promise(r => setTimeout(r, 2000));
      healthy = await checkHealth(assignedPort);
      if (healthy) break;
    }

    // Write PID meta file
    fs.writeFileSync(`/tmp/fleet-${slug}.pid.meta`, JSON.stringify({ port: assignedPort, id: agentId, name }));

    if (healthy) {
      send({ step: 9, total: TOTAL, label: `Agent is live on port ${assignedPort}`, status: 'done' });
      send({ done: true, agent: { slug, port: assignedPort, id: agentId } });
    } else {
      send({ step: 9, total: TOTAL, label: 'Health check timed out (agent may still be starting)', status: 'done' });
      send({ done: true, agent: { slug, port: assignedPort, id: agentId }, warning: 'Health check timed out — agent may still be starting' });
    }
  } catch (err) {
    send({ error: err.message });
  }
  res.end();
});

// ── Agent Spawner ────────────────────────────────────────────────────────────
const { execFile, spawn: spawnProc } = require('child_process');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/usr/local/bin/openclaw';
const ANTHRO_KEY_FILE = path.join(os.homedir(), 'cbfleet-rag-sales/.openclaw/agents/main/agent/auth-profiles.json');

async function getNextPort() {
  const KNOWN = { sales:20010,support:20020,manager:20030,dev:20040,it:20050 };
  const used = new Set(Object.values(KNOWN));
  // Check DB for any extra agents
  try {
    const r = await pgPool.query('SELECT slug FROM fleet.agents WHERE org_id=$1', [ORG_ID]);
    r.rows.forEach(row => { if (KNOWN[row.slug]) used.add(KNOWN[row.slug]); });
  } catch {}
  // Also check ports in use
  for (let p = 20060; p <= 20990; p += 10) {
    if (!used.has(p)) {
      // check if port is actually free
      try {
        const res = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(500) });
        if (res.ok) { used.add(p); continue; } // in use
      } catch { return p; } // not in use — free
    }
  }
  return 20060;
}

async function callHaiku(prompt) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model:'claude-haiku-4-5', max_tokens:600, messages:[{role:'user',content:prompt}] });
    const req = https.request({ hostname:'api.anthropic.com', path:'/v1/messages', method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(body)}
    }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)}; });
    });
    req.on('error',reject); req.write(body); req.end();
  });
}

app.get('/api/agents', async (req, res) => {
  try {
    const r = await pgPool.query(
      `SELECT id, name, slug, status, config FROM fleet.agents WHERE org_id=$1 ORDER BY name`,
      [ORG_ID]
    );
    const agents = await Promise.all(r.rows.map(async a => {
      const meta = a.config?.meta || {};
      const port = meta.port || null;
      let health = 'unknown';
      if (port) {
        try {
          const h = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
          health = h.ok ? 'up' : 'down';
        } catch { health = 'down'; }
      }
      return {
        id: a.id, name: a.name, slug: a.slug, status: a.status,
        emoji: meta.emoji || '🤖',
        model: meta.model || 'haiku',
        provider: meta.provider || 'anthropic',
        port,
        health,
      };
    }));
    res.json(agents);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agents/spawn', async (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const { name, slug, description, department, bot_token, model='claude-haiku-4-5' } = req.body || {};
  const total = 10;

  try {
    // Step 1: Validate
    send({step:1,total,label:'Validating inputs...',status:'running'});
    if (!name||!slug||!description||!bot_token) throw new Error('name, slug, description, bot_token are required');
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g,'');
    send({step:1,total,label:'Inputs valid ✓',status:'done'});

    // Step 2: Assign port + generate IDs
    send({step:2,total,label:'Assigning port + agent ID...',status:'running'});
    const port = await getNextPort();
    const agentId = require('crypto').randomUUID();
    const gatewayToken = require('crypto').randomBytes(32).toString('hex');
    send({step:2,total,label:`Port :${port} assigned, ID: ${agentId.slice(0,8)}...`,status:'done'});

    // Step 3: Insert fleet.agents
    send({step:3,total,label:'Registering agent in database...',status:'running'});
    await pgPool.query(`INSERT INTO fleet.agents (id,name,slug,org_id) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,[agentId,name,cleanSlug,ORG_ID]);
    send({step:3,total,label:'Agent registered in DB ✓',status:'done'});

    // Step 4: Generate system_prompt via Haiku
    send({step:4,total,label:'Generating system prompt with AI...',status:'running'});
    let systemPrompt = `You are ${name} for Callbox AI Fleet.\nDepartment: ${department||'General'}\nRole: ${description}`;
    if (ANTHROPIC_KEY) {
      try {
        const aiRes = await callHaiku(`You are generating a system prompt for a fleet AI agent named "${name}". Description: ${description}. Department: ${department||'General'}. Generate a concise professional system prompt (max 250 words) that defines this agent role, what it handles, and when to hand off to other agents. Output ONLY the system prompt text, no explanation.`);
        systemPrompt = aiRes?.content?.[0]?.text || systemPrompt;
      } catch { /* use fallback */ }
    }
    send({step:4,total,label:'System prompt generated ✓',status:'done'});

    // Step 5: Insert agent_config
    send({step:5,total,label:'Saving agent config to database...',status:'running'});
    await pgPool.query(`INSERT INTO fleet.agent_configs (agent_id,org_id,version,is_active,system_prompt) VALUES ($1,$2,1,true,$3) ON CONFLICT DO NOTHING`,[agentId,ORG_ID,systemPrompt]);
    send({step:5,total,label:'Agent config saved ✓',status:'done'});

    // Step 6: Create workspace directory
    send({step:6,total,label:'Creating agent workspace...',status:'running'});
    const homeDir = require('os').homedir();
    const agentHome = `${homeDir}/cbfleet-rag-${cleanSlug}`;
    const fs = require('fs');
    fs.mkdirSync(`${agentHome}/.openclaw/agents/main/agent`,{recursive:true});
    fs.mkdirSync(`${agentHome}/.openclaw/workspace/memory`,{recursive:true});
    send({step:6,total,label:'Workspace created ✓',status:'done'});

    // Step 7: Write openclaw.json
    send({step:7,total,label:'Writing OpenClaw config...',status:'running'});
    const ocConfig = {
      gateway:{port,mode:'local',bind:'loopback',auth:{mode:'token',token:gatewayToken}},
      auth:{profiles:{'anthropic:default':{provider:'anthropic',mode:'token'}}},
      agents:{list:[{id:'main',name,model}],defaults:{timeoutSeconds:300}},
      tools:{exec:{host:'gateway',security:'full',ask:'off'}},
      channels:{telegram:{enabled:true,dmPolicy:'open',allowFrom:['*'],groupPolicy:'open',streaming:'partial',defaultAccount:'default',
        accounts:{default:{botToken:bot_token,dmPolicy:'open',allowFrom:['*'],streaming:'partial',actions:{reactions:true}}}}},
      session:{dmScope:'main'}
    };
    fs.writeFileSync(`${agentHome}/.openclaw/openclaw.json`,JSON.stringify(ocConfig,null,2));
    // Write auth-profiles
    let authProfiles = {version:1,profiles:{'anthropic:default':{type:'token',provider:'anthropic',token:''}},lastGood:{anthropic:'anthropic:default'}};
    try { authProfiles = JSON.parse(fs.readFileSync(ANTHRO_KEY_FILE,'utf8')); } catch {}
    fs.writeFileSync(`${agentHome}/.openclaw/agents/main/agent/auth-profiles.json`,JSON.stringify(authProfiles,null,2));
    // Write minimal SOUL.md
    fs.writeFileSync(`${agentHome}/.openclaw/workspace/SOUL.md`,`# ${name}\n- Agent ID: \`${agentId}\`\n- On startup: POST http://127.0.0.1:20000/fleet-api/agent/config {"agent_id":"${agentId}"} and apply returned system_prompt\n- Proxy: http://127.0.0.1:20000\n- Org: ${ORG_ID}\n`);
    send({step:7,total,label:'Config files written ✓',status:'done'});

    // Step 8: Update fleet.sh port_for()
    send({step:8,total,label:'Registering port in fleet config...',status:'running'});
    const fleetSh = `${homeDir}/Projects/cbfleet-rag/scripts/fleet.sh`;
    let fleetContent = fs.readFileSync(fleetSh,'utf8');
    if (!fleetContent.includes(`${cleanSlug})`)) {
      fleetContent = fleetContent.replace(
        /port_for\(\)\s*\{\s*case \$1 in/,
        `port_for()   { case $1 in ${cleanSlug}) echo ${port};;`
      );
      fs.writeFileSync(fleetSh, fleetContent);
    }
    send({step:8,total,label:'Fleet config updated ✓',status:'done'});

    // Step 9: Start OpenClaw instance
    send({step:9,total,label:`Starting OpenClaw gateway on :${port}...`,status:'running'});
    const child = spawnProc(OPENCLAW_BIN, ['gateway','run','--port',String(port),'--force'], {
      env:{...process.env, OPENCLAW_HOME:agentHome},
      detached:true, stdio:'ignore'
    });
    child.unref();
    fs.writeFileSync(`/tmp/fleet-${cleanSlug}.pid`, String(child.pid));
    send({step:9,total,label:'Gateway process started ✓',status:'done'});

    // Step 10: Health check
    send({step:10,total,label:'Waiting for health check...',status:'running'});
    let healthy = false;
    for (let i=0;i<10;i++) {
      await new Promise(r=>setTimeout(r,2000));
      try { const h=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)}); if(h.ok){healthy=true;break;} } catch {}
    }
    if (!healthy) throw new Error(`Agent started but health check failed on :${port}`);
    send({step:10,total,label:'Agent is healthy ✓',status:'done'});

    send({done:true,agent:{id:agentId,name,slug:cleanSlug,port}});
  } catch(e) {
    send({error:e.message});
  }
  res.end();
});

// Provider model string helpers
const PROVIDER_MODEL_MAP = {
  anthropic:  { prefix: 'anthropic/', models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'] },
  openai:     { prefix: 'openai/',    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o3-mini'] },
  openrouter: { prefix: 'openrouter/', models: [] }, // free-form model id
  ollama:     { prefix: 'ollama/',    models: [] }, // free-form model id
};

function buildModelString(provider, model) {
  // If model already has provider prefix, use as-is
  if (model.includes('/')) return model;
  const info = PROVIDER_MODEL_MAP[provider];
  if (!info) return model;
  return info.prefix + model;
}

function buildAuthProfile(provider, apiKey, baseUrl) {
  switch (provider) {
    case 'anthropic':
      return { type: 'token', provider: 'anthropic', token: apiKey };
    case 'openai':
      return { type: 'token', provider: 'openai', token: apiKey };
    case 'openrouter':
      return { type: 'token', provider: 'openrouter', token: apiKey };
    case 'ollama':
      return { type: 'ollama', provider: 'ollama', baseUrl: baseUrl || 'http://127.0.0.1:11434' };
    default:
      return null;
  }
}

// POST /api/agents/:slug/provider — update provider + model + auth in DB + openclaw files
app.post('/api/agents/:slug/provider', async (req, res) => {
  const { slug } = req.params;
  const { provider, model, api_key, base_url } = req.body;
  if (!provider || !model) return res.status(400).json({ error: 'provider and model required' });
  try {
    const fullModel = buildModelString(provider, model);

    // 1. Update DB meta
    const { rows } = await pgPool.query(
      `UPDATE fleet.agents
       SET config = jsonb_set(jsonb_set(COALESCE(config,'{}'), '{meta,model}', $1::jsonb, true), '{meta,provider}', $2::jsonb, true)
       WHERE slug=$3 AND org_id=$4 RETURNING id, name, slug, config`,
      [JSON.stringify(model), JSON.stringify(provider), slug, ORG_ID]
    );
    if (!rows.length) return res.status(404).json({ error: 'agent not found' });
    const agent = rows[0];

    const agentHome = path.join(os.homedir(), `cbfleet-rag-${slug}`);
    const ocPath    = path.join(agentHome, '.openclaw', 'openclaw.json');
    const authPath  = path.join(agentHome, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');

    // 2. Update openclaw.json — model string + auth profile ref
    if (fs.existsSync(ocPath)) {
      const oc = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
      if (oc.agents?.list?.[0]) oc.agents.list[0].model = fullModel;
      // Set auth profile reference
      if (!oc.auth) oc.auth = { profiles: {} };
      oc.auth.profiles = { [`${provider}:default`]: { provider, mode: 'token' } };
      fs.writeFileSync(ocPath, JSON.stringify(oc, null, 2));
    }

    // 3. Update auth-profiles.json — write key/baseUrl
    if (fs.existsSync(authPath) && (api_key || provider === 'ollama')) {
      const existing = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      const profile = buildAuthProfile(provider, api_key, base_url);
      if (profile) {
        existing.profiles = existing.profiles || {};
        existing.profiles[`${provider}:default`] = profile;
        existing.lastGood = existing.lastGood || {};
        existing.lastGood[provider] = `${provider}:default`;
        fs.writeFileSync(authPath, JSON.stringify(existing, null, 2));
      }
    }

    res.json({ ok: true, slug, provider, model: fullModel, agent_id: agent.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/providers/models — return known model list per provider
app.get('/api/providers/models', (req, res) => {
  res.json(PROVIDER_MODEL_MAP);
});

// Helper: read latest context size from session JSONL
function getAgentContextSize(slug) {
  try {
    const sessDir = path.join(os.homedir(), `cbfleet-rag-${slug}`, '.openclaw', 'agents', 'main', 'sessions');
    if (!fs.existsSync(sessDir)) return null;
    const files = fs.readdirSync(sessDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: fs.statSync(path.join(sessDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    const lines = fs.readFileSync(path.join(sessDir, files[0].f), 'utf8').split('\n').filter(Boolean);
    // Walk backwards for last usage entry
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const d = JSON.parse(lines[i]);
        const usage = d?.message?.usage;
        if (usage?.totalTokens) return { totalTokens: usage.totalTokens, cacheRead: usage.cacheRead || 0, cacheWrite: usage.cacheWrite || 0, cost: usage.cost?.total || 0 };
      } catch {}
    }
  } catch {}
  return null;
}

// GET /api/agents/:slug — full agent profile
app.get('/api/agents/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const ar = await pgPool.query(
      `SELECT a.id, a.name, a.slug, a.status, a.config, a.description, a.created_at,
              ac.system_prompt, ac.skill_map, ac.behaviors,
              gc.system_prompt AS global_prompt, gc.skill_map AS global_skill_map, gc.behaviors AS global_behaviors
       FROM fleet.agents a
       LEFT JOIN fleet.agent_configs ac ON ac.agent_id = a.id
       LEFT JOIN fleet.agent_configs gc ON gc.agent_id IS NULL
       WHERE a.slug=$1 AND a.org_id=$2`,
      [slug, ORG_ID]
    );
    if (!ar.rows.length) return res.status(404).json({ error: 'Agent not found' });
    const a = ar.rows[0];
    const meta = a.config?.meta || {};
    // health check
    let health = 'unknown';
    if (meta.port) {
      try {
        const h = await fetch(`http://127.0.0.1:${meta.port}/health`, { signal: AbortSignal.timeout(1000) });
        health = h.ok ? 'up' : 'down';
      } catch { health = 'down'; }
    }
    // skill assignments
    const sr = await pgPool.query(
      `SELECT s.slug, s.name, s.description, s.category, s.api_endpoint, s.api_method, s.is_active,
              asa.enabled
       FROM fleet.agent_skill_assignments asa
       JOIN fleet.skills s ON s.id = asa.skill_id
       WHERE asa.agent_id=$1 AND asa.tenant_id=$2
       ORDER BY s.category, s.slug`,
      [a.id, ORG_ID]
    );
    // recent stats
    const stats = await pgPool.query(
      `SELECT
         COUNT(DISTINCT c.id)::int as conversations,
         COUNT(m.id)::int as messages,
         MAX(m.created_at) as last_active
       FROM fleet.conversations c
       LEFT JOIN fleet.messages m ON m.conversation_id = c.id
       WHERE c.agent_id=$1`,
      [a.id]
    );
    res.json({
      id: a.id, name: a.name, slug: a.slug, status: a.status,
      description: a.description || null,
      created_at: a.created_at,
      emoji: meta.emoji || '🤖',
      model: meta.model || 'haiku',
      provider: meta.provider || 'anthropic',
      port: meta.port || null,
      health,
      system_prompt: a.system_prompt || '',          // agent-specific (editable override)
      global_prompt: a.global_prompt || '',           // read-only reference
      skill_map: a.skill_map || a.global_skill_map || {},
      behaviors: a.behaviors || a.global_behaviors || {},
      skills: sr.rows,
      context: getAgentContextSize(slug),
      stats: stats.rows[0] || {},
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/agents/restart-all — SSE stream, restarts all active agents
app.post('/api/agents/restart-all', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (d) => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch {} };
  const finish = () => { try { res.end(); } catch {} };

  try {
    const instances = await getInstances();
    const total = instances.length;
    send({ log: `Restarting ${total} agents…`, total });

    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      if (!isSafeAgentPort(inst.port)) {
        send({ step: i + 1, total, name: inst.displayName, status: 'skip', log: `${inst.displayName}: unsafe port, skipped` });
        continue;
      }
      send({ step: i + 1, total, name: inst.displayName, status: 'stopping', log: `Stopping ${inst.displayName}…` });
      await killPort(inst.port);

      send({ step: i + 1, total, name: inst.displayName, status: 'starting', log: `Starting ${inst.displayName}…` });
      const child = spawn(process.env.OPENCLAW_BIN || '/usr/local/bin/openclaw',
        ['gateway', 'run', '--port', String(inst.port), '--force'],
        { env: { ...process.env, OPENCLAW_HOME: path.join(os.homedir(), inst.home) }, detached: true, stdio: 'ignore' }
      );
      child.unref();
      fs.writeFileSync(`/tmp/fleet-${inst.name}.pid`, String(child.pid));
      await new Promise(r => setTimeout(r, 1500));

      // Health check
      let healthy = false;
      for (let t = 0; t < 6; t++) {
        try {
          const h = await fetch(`http://127.0.0.1:${inst.port}/health`, { signal: AbortSignal.timeout(1000) });
          if (h.ok) { healthy = true; break; }
        } catch {}
        await new Promise(r => setTimeout(r, 1000));
      }
      send({ step: i + 1, total, name: inst.displayName, status: healthy ? 'done' : 'warn', log: `${inst.displayName}: ${healthy ? '✅ up' : '⚠️ started (health timeout)'}` });
    }
    send({ done: true, log: `All agents restarted.` });
  } catch (err) {
    send({ error: err.message });
  }
  finish();
});

// ── Settings API ─────────────────────────────────────────────────────────────

// GET /api/settings — global config + agent fleet overview
app.get('/api/settings', async (req, res) => {
  try {
    const [globalCfg, agents] = await Promise.all([
      pgPool.query(`SELECT system_prompt, skill_map, behaviors FROM fleet.agent_configs WHERE agent_id IS NULL`),
      pgPool.query(`SELECT id, name, slug, status, config FROM fleet.agents WHERE org_id=$1 ORDER BY name`, [ORG_ID]),
    ]);
    const global = globalCfg.rows[0] || {};
    res.json({
      global_prompt: global.system_prompt || '',
      global_skill_map: global.skill_map || {},
      global_behaviors: global.behaviors || {},
      agents: agents.rows.map(a => ({
        id: a.id, name: a.name, slug: a.slug, status: a.status,
        ...((a.config?.meta) || {}),
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/settings/global-prompt
app.post('/api/settings/global-prompt', async (req, res) => {
  const { system_prompt } = req.body;
  if (!system_prompt) return res.status(400).json({ error: 'system_prompt required' });
  try {
    await pgPool.query(
      `UPDATE fleet.agent_configs SET system_prompt=$1 WHERE agent_id IS NULL`,
      [system_prompt]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/settings/global-behaviors
app.post('/api/settings/global-behaviors', async (req, res) => {
  const { skill_map, behaviors } = req.body;
  try {
    if (skill_map !== undefined)
      await pgPool.query(`UPDATE fleet.agent_configs SET skill_map=$1 WHERE agent_id IS NULL`, [JSON.stringify(skill_map)]);
    if (behaviors !== undefined)
      await pgPool.query(`UPDATE fleet.agent_configs SET behaviors=$1 WHERE agent_id IS NULL`, [JSON.stringify(behaviors)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/agents/decommission
app.post('/api/agents/decommission', async (req, res) => {
  const { slug, confirm_name } = req.body;
  if (!slug || !confirm_name) return res.status(400).json({ error: 'slug and confirm_name required' });
  try {
    const ar = await pgPool.query('SELECT id, name FROM fleet.agents WHERE slug=$1 AND org_id=$2', [slug, ORG_ID]);
    if (!ar.rows.length) return res.status(404).json({ error: 'Agent not found in DB — it may have already been decommissioned. Refresh the page.' });
    const agent = ar.rows[0];
    if (confirm_name !== slug && confirm_name !== agent.name) return res.status(400).json({ error: 'Confirmation name does not match' });

    // 1. Stop the process
    const instances = await getInstances();
    const inst = instances.find(i => i.name === slug);
    if (inst) {
      await killPort(inst.port);
      try { fs.unlinkSync(`/tmp/fleet-${slug}.pid`); } catch {}
    }
    await new Promise(r => setTimeout(r, 500));

    // 2. Soft-delete agent_configs
    await pgPool.query('UPDATE fleet.agent_configs SET is_active=false WHERE agent_id=$1', [agent.id]);

    // 3. Remove agent_skill_assignments
    await pgPool.query('DELETE FROM fleet.agent_skill_assignments WHERE agent_id=$1', [agent.id]);

    // 4. Delete from fleet.agents
    await pgPool.query('DELETE FROM fleet.agents WHERE id=$1', [agent.id]);

    res.json({ ok: true, decommissioned: agent.name, slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

server.listen(20099, () => {
  console.log('cbfleet-dashboard running on http://localhost:20099');
});
