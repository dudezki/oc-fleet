/**
 * Callbox Google Workspace OAuth Proxy
 * Fleet v2 — Linux/macOS compatible (env vars, no Keychain)
 * Port: 19001
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REDIRECT_URI  (e.g. https://your-vm-domain/google-auth/callback)
 *   TOKEN_STORE_DIR      (default: /var/callbox/google-tokens)
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Client } = require('pg');

const PORT = parseInt(process.env.GOOGLE_AUTH_PORT || '19001');
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in environment');
const DB_URL = process.env.LOCAL_DB_URL || 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev';
const TOKEN_DIR = process.env.TOKEN_STORE_DIR || path.join(require('os').homedir(), '.callbox-google-tokens');
const ALLOWED_DOMAIN = 'callboxinc.com';

// REDIRECT_URI loaded from DB skill_callbacks at startup (set via dashboard or SQL)
let REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://oc.callboxinc.ai/callback/google';

async function loadRedirectUriFromDb() {
  const pg = new Client({ connectionString: DB_URL });
  try {
    await pg.connect();
    const r = await pg.query(
      `SELECT request_schema->'_config'->>'oauth_callback_url' as callback_url
       FROM fleet.skills WHERE slug = 'google-workspace' LIMIT 1`
    );
    const cbUrl = r.rows[0]?.callback_url;
    if (cbUrl && !cbUrl.includes('YOUR_VM_DOMAIN')) {
      REDIRECT_URI = cbUrl;
      console.log(`[google-auth] Redirect URI loaded from DB: ${REDIRECT_URI}`);
    } else {
      console.warn(`[google-auth] ⚠️  oauth_callback_url not set — update request_schema._config.oauth_callback_url in fleet.skills`);
    }
  } catch (e) {
    console.warn(`[google-auth] Could not load redirect URI from DB: ${e.message}`);
  } finally {
    await pg.end().catch(() => {});
  }
}

// ─── Token storage — DB-first, file fallback ────────────────────────────────

const ORG_ID = 'f86d92cb-db10-43ff-9ff2-d69c319d272d';

async function dbQuery(sql, params = []) {
  const pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  try { return await pg.query(sql, params); }
  finally { await pg.end().catch(() => {}); }
}

async function saveRefreshToken(email, token, scopes = [], meta = {}) {
  try {
    const acct = await dbQuery(`SELECT id FROM fleet.accounts WHERE email=$1 AND org_id=$2`, [email, ORG_ID]);
    if (!acct.rows.length) throw new Error(`Account not found for ${email}`);
    const account_id = acct.rows[0].id;
    const scopeArr = Array.isArray(scopes) ? scopes : [];

    // Resolve access_level from account role
    const roleRow = await dbQuery(`SELECT role FROM fleet.accounts WHERE id=$1`, [account_id]);
    const accountRole = roleRow.rows[0]?.role || 'agent';
    const accessLevel = accountRole === 'admin' ? 'admin' : accountRole === 'team_lead' ? 'team' : 'standard';

    // Google tokens don't expire (refresh tokens are long-lived) — set far future
    const expiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();

    await dbQuery(`
      INSERT INTO fleet.user_integrations
        (org_id, account_id, integration, portal_id, enabled, access_level, scopes, credentials, meta, last_used_at, expires_at)
      VALUES ($1,$2,'google',NULL,true,$3,$4,$5,$6,now(),$7)
      ON CONFLICT (org_id, account_id, integration, portal_id) DO UPDATE SET
        credentials  = EXCLUDED.credentials,
        scopes       = CASE WHEN array_length(EXCLUDED.scopes,1) > 0 THEN EXCLUDED.scopes ELSE fleet.user_integrations.scopes END,
        meta         = CASE WHEN EXCLUDED.meta != '{}'::jsonb THEN EXCLUDED.meta ELSE fleet.user_integrations.meta END,
        access_level = EXCLUDED.access_level,
        enabled      = true,
        last_used_at = now(),
        expires_at   = EXCLUDED.expires_at,
        updated_at   = now()
    `, [ORG_ID, account_id, accessLevel, scopeArr, JSON.stringify({ refresh_token: token, issued_at: Date.now() }), JSON.stringify({ email, ...meta }), expiresAt]);
    console.log(`[google-auth] Refresh token saved to DB for ${email}`);
  } catch (err) {
    console.error(`[google-auth] DB save failed, falling back to file: ${err.message}`);
    try { fs.mkdirSync(TOKEN_DIR, { recursive: true }); fs.writeFileSync(path.join(TOKEN_DIR, `${email}.token`), token, 'utf8'); } catch {}
  }
}

async function loadRefreshToken(email) {
  try {
    const result = await dbQuery(
      `SELECT ui.credentials FROM fleet.user_integrations ui
       JOIN fleet.accounts a ON a.id = ui.account_id
       WHERE a.email=$1 AND ui.integration='google' AND ui.enabled=true AND ui.org_id=$2`,
      [email, ORG_ID]
    );
    if (result.rows.length) {
      const creds = result.rows[0].credentials;
      return creds.refresh_token || creds.token || null;
    }
  } catch (err) {
    console.error(`[google-auth] DB load failed, falling back to file: ${err.message}`);
  }
  // File fallback — auto-migrate to DB
  try {
    const token = fs.readFileSync(path.join(TOKEN_DIR, `${email}.token`), 'utf8').trim();
    if (token) {
      console.log(`[google-auth] Migrating file token to DB for ${email}`);
      await saveRefreshToken(email, token);
      try { fs.unlinkSync(path.join(TOKEN_DIR, `${email}.token`)); } catch {}
    }
    return token || null;
  } catch { return null; }
}

async function deleteRefreshToken(email) {
  try {
    await dbQuery(
      `UPDATE fleet.user_integrations ui SET enabled=false, updated_at=now()
       FROM fleet.accounts a
       WHERE a.id=ui.account_id AND a.email=$1 AND ui.integration='google' AND ui.org_id=$2`,
      [email, ORG_ID]
    );
    console.log(`[google-auth] Token disabled in DB for ${email}`);
  } catch (err) {
    console.error(`[google-auth] DB delete failed: ${err.message}`);
  }
  try { fs.unlinkSync(path.join(TOKEN_DIR, `${email}.token`)); } catch {}
}

// ─── OAuth persistence tables ──────────────────────────────────────────────────

async function initOAuthTables() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS fleet.google_oauth_pending (
        state TEXT PRIMARY KEY,
        scopes TEXT[],
        created_at TIMESTAMPTZ DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS fleet.google_oauth_completed (
        state TEXT PRIMARY KEY,
        email TEXT,
        completed_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    // Cleanup expired entries on startup
    await dbQuery(`DELETE FROM fleet.google_oauth_pending WHERE expires_at < now()`);
    await dbQuery(`DELETE FROM fleet.google_oauth_completed WHERE completed_at < now() - INTERVAL '60 seconds'`);
    console.log('[google-auth] OAuth persistence tables ready');
  } catch (e) {
    console.warn('[google-auth] Could not init OAuth tables:', e.message);
  }
}

// Periodic cleanup every 10 minutes
setInterval(async () => {
  try {
    await dbQuery(`DELETE FROM fleet.google_oauth_pending WHERE expires_at < now()`);
    await dbQuery(`DELETE FROM fleet.google_oauth_completed WHERE completed_at < now() - INTERVAL '60 seconds'`);
  } catch (e) {
    console.warn('[google-auth] Periodic OAuth cleanup error:', e.message);
  }
}, 10 * 60 * 1000);

// ─── In-memory session store ──────────────────────────────────────────────────

const sessions = new Map(); // email → session
const pendingAuths = new Map(); // state → { resolve, reject, scopes, timer }
const completedCallbacks = new Map(); // state → { email, ts } (dedup 60s)

const SESSION_IDLE_MS = 4 * 60 * 60 * 1000; // 4h

function touchSession(email) {
  const s = sessions.get(email);
  if (!s) return;
  if (s._idleTimer) clearTimeout(s._idleTimer);
  s.last_used = Date.now();
  s._idleTimer = setTimeout(() => {
    console.log(`[google-auth] Session idle: ${email}`);
    destroySession(email);
  }, SESSION_IDLE_MS);
}

function destroySession(email, { revokeToken = false } = {}) {
  const s = sessions.get(email);
  if (s?._idleTimer) clearTimeout(s._idleTimer);
  sessions.delete(email);
  if (revokeToken) deleteRefreshToken(email).catch(() => {});
  console.log(`[google-auth] Session destroyed: ${email}`);
}

function getSession(email) {
  if (!sessions.has(email)) return null;
  touchSession(email);
  return sessions.get(email);
}

// ─── OAuth helpers ────────────────────────────────────────────────────────────

const SCOPE_MAP = {
  drive: 'https://www.googleapis.com/auth/drive',
  docs: 'https://www.googleapis.com/auth/documents',
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  slides: 'https://www.googleapis.com/auth/presentations',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  gmail_send: 'https://www.googleapis.com/auth/gmail.send',
  'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
  calendar: 'https://www.googleapis.com/auth/calendar',
  chat: 'https://www.googleapis.com/auth/chat.messages.create',
  email: 'https://www.googleapis.com/auth/userinfo.email',
  profile: 'https://www.googleapis.com/auth/userinfo.profile',
};

function buildAuthUrl(scopes, state) {
  const scopeStr = [
    SCOPE_MAP.email,
    SCOPE_MAP.profile,
    ...scopes.map(s => SCOPE_MAP[s] || s),
  ].join(' ');
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: scopeStr,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })}`;
}

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function exchangeCode(code) {
  return httpsPost('oauth2.googleapis.com', '/token', new URLSearchParams({
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
  }).toString());
}

async function refreshAccessToken(session) {
  const newToken = await httpsPost('oauth2.googleapis.com', '/token', new URLSearchParams({
    refresh_token: session.refresh_token, client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET, grant_type: 'refresh_token',
  }).toString());
  Object.assign(session, newToken, { expires_at: Date.now() + newToken.expires_in * 1000 });
  touchSession(session.email);
  return session;
}

function getUserInfo(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.googleapis.com', path: '/oauth2/v2/userinfo',
      headers: { Authorization: `Bearer ${accessToken}` },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };

  const html = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'text/html' });
    res.end(body);
  };

  const readBody = () => new Promise(resolve => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => resolve(b));
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  // ── Health ──────────────────────────────────────────────────────────────────
  if (parsed.pathname === '/health') {
    return json(200, { ok: true, activeSessions: sessions.size, pendingAuths: pendingAuths.size });
  }

  // ── POST /auth/request — start OAuth flow ───────────────────────────────────
  if (parsed.pathname === '/auth/request' && req.method === 'POST') {
    try {
      const { scopes = ['drive', 'gmail', 'calendar'], email } = JSON.parse(await readBody());
      // If already authenticated, return token immediately
      if (email) {
        let s = getSession(email);
        if (!s) {
          const saved = await loadRefreshToken(email);
          if (saved) {
            const stub = { email, refresh_token: saved, access_token: null, expires_at: 0 };
            sessions.set(email, stub);
            s = stub;
          }
        }
        if (s) {
          if (!s.access_token || (s.expires_at && Date.now() > s.expires_at - 60000)) {
            await refreshAccessToken(s);
          }
          return json(200, { already_authenticated: true, email, access_token: s.access_token });
        }
      }
      const state = crypto.randomBytes(16).toString('hex');
      const authUrl = buildAuthUrl(scopes, state);
      const TIMEOUT = 60 * 60 * 1000; // 1 hour
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pendingAuths.delete(state); reject(new Error('timeout')); }, TIMEOUT);
        pendingAuths.set(state, { resolve, reject, scopes, timer });
      }).catch(() => {});
      // Persist to DB so state survives process restarts
      dbQuery(
        `INSERT INTO fleet.google_oauth_pending (state, scopes, expires_at) VALUES ($1, $2, now() + INTERVAL '1 hour') ON CONFLICT (state) DO NOTHING`,
        [state, scopes]
      ).catch(e => console.warn('[google-auth] DB insert pending failed:', e.message));
      return json(200, { auth_url: authUrl, state });
    } catch (err) {
      return json(400, { error: err.message });
    }
  }

  // ── GET /auth/status — poll for completion ──────────────────────────────────
  if (parsed.pathname === '/auth/status') {
    const { state, email } = parsed.query;
    if (state && pendingAuths.has(state)) return json(200, { status: 'pending' });
    if (state) {
      try {
        // Check DB completed table (callback fired after restart)
        const cr = await dbQuery(`SELECT email FROM fleet.google_oauth_completed WHERE state=$1`, [state]);
        if (cr.rows.length) return json(200, { status: 'done', email: cr.rows[0].email });
        // Check DB pending table (still waiting, process restarted)
        const pr = await dbQuery(`SELECT state FROM fleet.google_oauth_pending WHERE state=$1 AND expires_at > now()`, [state]);
        if (pr.rows.length) return json(200, { status: 'pending' });
      } catch (e) {
        console.warn('[google-auth] DB status check error:', e.message);
      }
    }
    if (email && getSession(email)) return json(200, { status: 'authenticated', email });
    return json(200, { status: 'unauthenticated' });
  }

  // ── GET /token — get access token ──────────────────────────────────────────
  if (parsed.pathname === '/token') {
    const { email } = parsed.query;
    if (!email) return json(400, { error: 'email required' });
    let s = getSession(email);
    if (!s) {
      const saved = await loadRefreshToken(email);
      if (!saved) return json(404, { error: 'No session for ' + email + ' — auth required.' });
      try {
        const stub = { email, refresh_token: saved, access_token: null, expires_at: 0, _idleTimer: null };
        sessions.set(email, stub);
        await refreshAccessToken(stub);
        s = stub;
        touchSession(email);
      } catch {
        deleteRefreshToken(email);
        return json(401, { error: 'Saved token invalid — re-auth required.' });
      }
    }
    if (!s.access_token || (s.expires_at && Date.now() > s.expires_at - 60000)) {
      try { await refreshAccessToken(s); }
      catch { destroySession(email); return json(401, { error: 'Token refresh failed — re-auth required.' }); }
    }
    return json(200, { access_token: s.access_token, email });
  }

  // ── GET /sessions — list active sessions ───────────────────────────────────
  if (parsed.pathname === '/sessions') {
    return json(200, {
      sessions: [...sessions.values()].map(s => ({
        email: s.email, scopes: s.scopes, last_used: s.last_used, created_at: s.created_at,
      }))
    });
  }

  // ── POST /session/destroy ───────────────────────────────────────────────────
  if (parsed.pathname === '/session/destroy' && req.method === 'POST') {
    const { email, revoke = false } = JSON.parse(await readBody());
    if (!email) return json(400, { error: 'email required' });
    destroySession(email, { revokeToken: revoke });
    return json(200, { ok: true, email });
  }

  // ── OAuth callback from Google ──────────────────────────────────────────────
  if (parsed.pathname === '/google-auth/callback' || parsed.pathname === '/callback' || parsed.pathname === '/callback/google') {
    const { code, state, error } = parsed.query;

    if (error) {
      const p = pendingAuths.get(state);
      if (p) { clearTimeout(p.timer); p.reject(new Error('denied')); pendingAuths.delete(state); }
      return html(400, `<html><body style="font-family:sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h2>❌ Access cancelled</h2><p style="color:#64748b">Close this tab and try again.</p></div></body></html>`);
    }

    // Determine if state is valid: check in-memory first, then DB (for post-restart)
    let pendingFromDb = null;
    if (!code || !state) {
      return html(400, '<h2>Invalid or expired auth request.</h2>');
    }
    if (!pendingAuths.has(state)) {
      // Check in-memory dedup
      if (completedCallbacks.has(state)) {
        return html(200, `<html><body style="font-family:sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h2>✅ Already connected</h2><p style="color:#64748b">You can close this tab.</p></div></body></html>`);
      }
      // Check DB completed (already processed after restart)
      try {
        const cr = await dbQuery(`SELECT email FROM fleet.google_oauth_completed WHERE state=$1`, [state]);
        if (cr.rows.length) {
          return html(200, `<html><body style="font-family:sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h2>✅ Already connected</h2><p style="color:#64748b">You can close this tab.</p></div></body></html>`);
        }
      } catch (e) { console.warn('[google-auth] DB completed check error:', e.message); }
      // Check DB pending (state was created before a restart)
      try {
        const pr = await dbQuery(`SELECT scopes FROM fleet.google_oauth_pending WHERE state=$1 AND expires_at > now()`, [state]);
        if (pr.rows.length) {
          pendingFromDb = { scopes: pr.rows[0].scopes || [] };
        }
      } catch (e) { console.warn('[google-auth] DB pending check error:', e.message); }
      if (!pendingFromDb) {
        return html(400, '<h2>Invalid or expired auth request.</h2>');
      }
    }

    try {
      const pending = pendingAuths.has(state) ? pendingAuths.get(state) : pendingFromDb;
      if (pendingAuths.has(state)) {
        pendingAuths.delete(state);
        clearTimeout(pending.timer);
      }
      // Remove from DB pending table (cleanup)
      dbQuery(`DELETE FROM fleet.google_oauth_pending WHERE state=$1`, [state]).catch(() => {});

      const tokenData = await exchangeCode(code);
      if (!tokenData?.access_token) throw new Error('Token exchange failed');

      const userInfo = await getUserInfo(tokenData.access_token);
      const email = userInfo?.email;
      if (!email) throw new Error('Could not get email from Google');

      if (!email.endsWith('@' + ALLOWED_DOMAIN)) {
        if (pending.reject) pending.reject(new Error('Unauthorized domain: ' + email));
        return html(403, `<html><body style="font-family:sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h2>🔒 Access Denied</h2><p style="color:#f87171">${email}</p><p style="color:#64748b">Only @callboxinc.com accounts allowed.</p></div></body></html>`);
      }

      const session = {
        email, access_token: tokenData.access_token, refresh_token: tokenData.refresh_token,
        expires_at: Date.now() + tokenData.expires_in * 1000,
        scopes: pending.scopes, created_at: Date.now(), last_used: Date.now(), _idleTimer: null,
      };
      sessions.set(email, session);
      if (tokenData.refresh_token) saveRefreshToken(email, tokenData.refresh_token, pending.scopes || []).catch(console.error);
      touchSession(email);

      if (pendingFromDb) {
        // State was from DB (post-restart) — store completion in DB for status polling
        dbQuery(
          `INSERT INTO fleet.google_oauth_completed (state, email) VALUES ($1, $2) ON CONFLICT (state) DO NOTHING`,
          [state, email]
        ).catch(() => {});
        setTimeout(() => dbQuery(`DELETE FROM fleet.google_oauth_completed WHERE state=$1`, [state]).catch(() => {}), 60000);
      } else {
        // Normal in-memory flow
        completedCallbacks.set(state, { email, ts: Date.now() });
        setTimeout(() => completedCallbacks.delete(state), 60000);
        pending.resolve({ email, session });
      }

      return html(200, `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>Connected — Callbox AI</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;}
.card{background:#1a1d27;border:1px solid #2d3148;border-radius:16px;padding:48px 56px;max-width:420px;width:90%;text-align:center;}
.icon{width:72px;height:72px;background:linear-gradient(135deg,#22c55e,#16a34a);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px;font-size:32px;}
h1{font-size:22px;font-weight:700;margin-bottom:8px;}
.email{background:#0f1117;border:1px solid #2d3148;border-radius:10px;padding:12px 18px;margin:20px 0;font-size:13px;color:#94a3b8;}
p{font-size:13px;color:#64748b;line-height:1.6;}
.brand{margin-top:32px;font-size:11px;color:#374151;text-transform:uppercase;letter-spacing:0.5px;}</style></head>
<body><div class="card"><div class="icon">✓</div><h1>You're connected!</h1>
<div class="email">${email}</div>
<p>Close this tab and return to the chat — your Google Workspace session is active.</p>
<div class="brand">Callbox AI · Fleet v2</div></div></body></html>`);
    } catch (err) {
      console.error('[google-auth] callback error:', err.message);
      return html(500, '<h2>Auth failed. Please try again.</h2>');
    }
  }

  // ── Google API helpers ───────────────────────────────────────────────────────

  async function getAccessToken(email) {
    let s = getSession(email);
    if (!s) {
      const saved = await loadRefreshToken(email);
      if (!saved) throw { status: 401, reason: 'auth_required', message: `No session for ${email} — auth required.` };
      const stub = { email, refresh_token: saved, access_token: null, expires_at: 0, _idleTimer: null };
      sessions.set(email, stub);
      await refreshAccessToken(stub);
      s = stub;
      touchSession(email);
    }
    if (!s.access_token || (s.expires_at && Date.now() > s.expires_at - 60000)) {
      await refreshAccessToken(s);
    }
    return s.access_token;
  }

  async function gapi(method, url, token, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const options = {
        hostname: u.hostname, path: u.pathname + u.search, method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      };
      const req = https.request(options, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d }); } });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  const body = await readBody();
  let p = {};
  try { p = JSON.parse(body); } catch {}

  // ── Docs ────────────────────────────────────────────────────────────────────
  if (parsed.pathname === '/docs/create' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const doc = await gapi('POST', 'https://docs.googleapis.com/v1/documents', token, { title: p.title || 'Untitled' });
      if (p.content && doc.documentId) {
        await gapi('POST', `https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, token, {
          requests: [{ insertText: { location: { index: 1 }, text: p.content } }]
        });
      }
      return json(200, { ok: true, doc_id: doc.documentId, url: `https://docs.google.com/document/d/${doc.documentId}/edit`, title: doc.title });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  if (parsed.pathname === '/docs/get' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const docId = p.doc_id?.replace(/.*\/d\/([^/]+).*/, '$1') || p.doc_id;
      const doc = await gapi('GET', `https://docs.googleapis.com/v1/documents/${docId}`, token);
      const text = doc.body?.content?.map(el => el.paragraph?.elements?.map(e => e.textRun?.content || '').join('')).join('') || '';
      return json(200, { ok: true, doc_id: docId, title: doc.title, content: text });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  if (parsed.pathname === '/docs/update' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const docId = p.doc_id?.replace(/.*\/d\/([^/]+).*/, '$1') || p.doc_id;
      const doc = await gapi('GET', `https://docs.googleapis.com/v1/documents/${docId}`, token);
      const endIndex = doc.body?.content?.slice(-1)[0]?.endIndex || 1;
      const requests = p.mode === 'replace'
        ? [
            { deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } },
            { insertText: { location: { index: 1 }, text: p.content } }
          ]
        : [{ insertText: { location: { index: endIndex - 1 }, text: '\n' + p.content } }];
      await gapi('POST', `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, token, { requests });
      return json(200, { ok: true, doc_id: docId, url: `https://docs.google.com/document/d/${docId}/edit` });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  if (parsed.pathname === '/docs/delete' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const docId = p.doc_id?.replace(/.*\/d\/([^/]+).*/, '$1') || p.doc_id;
      await gapi('DELETE', `https://www.googleapis.com/drive/v3/files/${docId}`, token);
      return json(200, { ok: true, doc_id: docId, trashed: true });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  // ── Sheets ──────────────────────────────────────────────────────────────────
  if (parsed.pathname === '/sheets/create' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const sheet = await gapi('POST', 'https://sheets.googleapis.com/v4/spreadsheets', token, {
        properties: { title: p.title || 'Untitled Spreadsheet' },
        sheets: [{ properties: { title: 'Sheet1' } }]
      });
      if (p.data && sheet.spreadsheetId) {
        await gapi('PUT', `https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values/Sheet1!A1?valueInputOption=USER_ENTERED`, token, { values: p.data });
      }
      return json(200, { ok: true, sheet_id: sheet.spreadsheetId, url: sheet.spreadsheetUrl, title: sheet.properties?.title });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  if (parsed.pathname === '/sheets/read' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const sheetId = p.sheet_id?.replace(/.*\/d\/([^/]+).*/, '$1') || p.sheet_id;
      const range = p.range || 'Sheet1!A1:Z1000';
      const r = await gapi('GET', `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`, token);
      return json(200, { ok: true, sheet_id: sheetId, range: r.range, values: r.values || [] });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  if (parsed.pathname === '/sheets/write' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const sheetId = p.sheet_id?.replace(/.*\/d\/([^/]+).*/, '$1') || p.sheet_id;
      const range = p.range || 'Sheet1!A1';
      const mode = p.mode === 'append' ? 'append' : 'values';
      const url = mode === 'append'
        ? `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`
        : `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
      const method = mode === 'append' ? 'POST' : 'PUT';
      const r = await gapi(method, url, token, { values: p.values });
      return json(200, { ok: true, updated_rows: r.updates?.updatedRows || r.updates?.updatedCells });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  if (parsed.pathname === '/sheets/delete' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const sheetId = p.sheet_id?.replace(/.*\/d\/([^/]+).*/, '$1') || p.sheet_id;
      await gapi('DELETE', `https://www.googleapis.com/drive/v3/files/${sheetId}`, token);
      return json(200, { ok: true, sheet_id: sheetId, trashed: true });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  // ── Slides ──────────────────────────────────────────────────────────────────
  if (parsed.pathname === '/slides/create' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const pres = await gapi('POST', 'https://slides.googleapis.com/v1/presentations', token, { title: p.title || 'Untitled Presentation' });
      return json(200, { ok: true, presentation_id: pres.presentationId, url: `https://docs.google.com/presentation/d/${pres.presentationId}/edit`, title: pres.title });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  if (parsed.pathname === '/slides/get' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const presId = p.presentation_id?.replace(/.*\/d\/([^/]+).*/, '$1') || p.presentation_id;
      const pres = await gapi('GET', `https://slides.googleapis.com/v1/presentations/${presId}`, token);
      return json(200, { ok: true, presentation_id: presId, title: pres.title, slide_count: pres.slides?.length || 0, url: `https://docs.google.com/presentation/d/${presId}/edit` });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  if (parsed.pathname === '/slides/delete' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const presId = p.presentation_id?.replace(/.*\/d\/([^/]+).*/, '$1') || p.presentation_id;
      await gapi('DELETE', `https://www.googleapis.com/drive/v3/files/${presId}`, token);
      return json(200, { ok: true, presentation_id: presId, trashed: true });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  // ── Drive ───────────────────────────────────────────────────────────────────
  if (parsed.pathname === '/drive/list' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const q = p.query ? encodeURIComponent(p.query) : '';
      const limit = p.limit || 20;
      const url = `https://www.googleapis.com/drive/v3/files?pageSize=${limit}&fields=files(id,name,mimeType,webViewLink,modifiedTime)${q ? '&q=' + q : ''}`;
      const r = await gapi('GET', url, token);
      return json(200, { ok: true, files: r.files || [] });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  if (parsed.pathname === '/drive/delete' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      await gapi('DELETE', `https://www.googleapis.com/drive/v3/files/${p.file_id}`, token);
      return json(200, { ok: true, file_id: p.file_id, trashed: true });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  if (parsed.pathname === '/drive/share' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const perm = p.share_with === 'anyone'
        ? { type: 'anyone', role: p.role || 'reader' }
        : { type: 'user', role: p.role || 'reader', emailAddress: p.share_with };
      await gapi('POST', `https://www.googleapis.com/drive/v3/files/${p.file_id}/permissions`, token, perm);
      return json(200, { ok: true, file_id: p.file_id, shared_with: p.share_with, role: p.role || 'reader' });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  // ── Gmail ───────────────────────────────────────────────────────────────────
  if (parsed.pathname === '/gmail/send' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const raw = Buffer.from(
        `From: ${p.email}\r\nTo: ${p.to}\r\nSubject: ${p.subject}\r\nContent-Type: ${p.html ? 'text/html' : 'text/plain'}; charset=utf-8\r\n\r\n${p.body}`
      ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const r = await gapi('POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', token, { raw });
      return json(200, { ok: true, message_id: r.id, thread_id: r.threadId });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  if (parsed.pathname === '/gmail/read' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const limit = p.limit || 10;
      const q = p.query ? `&q=${encodeURIComponent(p.query)}` : '';
      const list = await gapi('GET', `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}${q}`, token);
      const messages = await Promise.all((list.messages || []).slice(0, limit).map(async m => {
        const msg = await gapi('GET', `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From,Subject,Date`, token);
        const headers = Object.fromEntries((msg.payload?.headers || []).map(h => [h.name, h.value]));
        return { id: m.id, from: headers.From, subject: headers.Subject, date: headers.Date, snippet: msg.snippet };
      }));
      return json(200, { ok: true, messages });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  // ── Calendar ─────────────────────────────────────────────────────────────────
  if (parsed.pathname === '/calendar/list' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const now = new Date().toISOString();
      const end = new Date(Date.now() + (p.days_ahead || 7) * 86400000).toISOString();
      const limit = p.limit || 10;
      const r = await gapi('GET', `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(now)}&timeMax=${encodeURIComponent(end)}&maxResults=${limit}&singleEvents=true&orderBy=startTime`, token);
      const events = (r.items || []).map(e => ({ id: e.id, title: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location, link: e.htmlLink }));
      return json(200, { ok: true, events });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  if (parsed.pathname === '/calendar/create' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      const event = {
        summary: p.title, description: p.description,
        start: { dateTime: p.start, timeZone: 'Asia/Manila' },
        end: { dateTime: p.end, timeZone: 'Asia/Manila' },
        attendees: (p.attendees || []).map(e => ({ email: e })),
      };
      const r = await gapi('POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/events', token, event);
      return json(200, { ok: true, event_id: r.id, url: r.htmlLink, title: r.summary });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  if (parsed.pathname === '/calendar/delete' && req.method === 'POST') {
    try {
      const token = await getAccessToken(p.email);
      await gapi('DELETE', `https://www.googleapis.com/calendar/v3/calendars/primary/events/${p.event_id}`, token);
      return json(200, { ok: true, event_id: p.event_id, deleted: true });
    } catch (e) { return json(e.status || 500, { error: e.message, reason: e.reason }); }
  }

  res.writeHead(404);
  res.end('Not found');
});

// Load redirect URI from DB and init OAuth tables before starting
initOAuthTables().then(() => loadRedirectUriFromDb()).then(() => server.listen(PORT, '127.0.0.1', () => {
  console.log(`[google-auth] Running on http://127.0.0.1:${PORT}`);
  console.log(`[google-auth] Callback: ${REDIRECT_URI}`);
  console.log(`[google-auth] Token store: ${TOKEN_DIR}`);
  if (REDIRECT_URI.includes('YOUR_VM_DOMAIN')) {
    console.warn('[google-auth] ⚠️  REDIRECT_URI not set — update skill callback \'oauth-callback\' in /knowledge dashboard');
  }
}));

process.on('uncaughtException', err => console.error('[google-auth] Uncaught:', err.message));
process.on('unhandledRejection', reason => console.error('[google-auth] Unhandled:', reason));
