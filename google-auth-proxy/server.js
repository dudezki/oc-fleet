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
let REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://YOUR_VM_DOMAIN/google-auth/callback';

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

// ─── Token file storage (Linux-safe, replaces Keychain) ──────────────────────

function saveRefreshToken(email, token) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  fs.writeFileSync(path.join(TOKEN_DIR, `${email}.token`), token, 'utf8');
  console.log(`[google-auth] Refresh token saved for ${email}`);
}

function loadRefreshToken(email) {
  try { return fs.readFileSync(path.join(TOKEN_DIR, `${email}.token`), 'utf8').trim(); }
  catch { return null; }
}

function deleteRefreshToken(email) {
  try { fs.unlinkSync(path.join(TOKEN_DIR, `${email}.token`)); }
  catch {}
}

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
  if (revokeToken) deleteRefreshToken(email);
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
          const saved = loadRefreshToken(email);
          if (saved) {
            // Restore from file
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
      return json(200, { auth_url: authUrl, state });
    } catch (err) {
      return json(400, { error: err.message });
    }
  }

  // ── GET /auth/status — poll for completion ──────────────────────────────────
  if (parsed.pathname === '/auth/status') {
    const { state, email } = parsed.query;
    if (state && pendingAuths.has(state)) return json(200, { status: 'pending' });
    if (email && getSession(email)) return json(200, { status: 'authenticated', email });
    return json(200, { status: 'unauthenticated' });
  }

  // ── GET /token — get access token ──────────────────────────────────────────
  if (parsed.pathname === '/token') {
    const { email } = parsed.query;
    if (!email) return json(400, { error: 'email required' });
    let s = getSession(email);
    if (!s) {
      const saved = loadRefreshToken(email);
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
  if (parsed.pathname === '/google-auth/callback' || parsed.pathname === '/callback') {
    const { code, state, error } = parsed.query;

    if (error) {
      const p = pendingAuths.get(state);
      if (p) { clearTimeout(p.timer); p.reject(new Error('denied')); pendingAuths.delete(state); }
      return html(400, `<html><body style="font-family:sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h2>❌ Access cancelled</h2><p style="color:#64748b">Close this tab and try again.</p></div></body></html>`);
    }

    if (!code || !state || !pendingAuths.has(state)) {
      if (completedCallbacks.has(state)) {
        return html(200, `<html><body style="font-family:sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h2>✅ Already connected</h2><p style="color:#64748b">You can close this tab.</p></div></body></html>`);
      }
      return html(400, '<h2>Invalid or expired auth request.</h2>');
    }

    try {
      const pending = pendingAuths.get(state);
      pendingAuths.delete(state);
      clearTimeout(pending.timer);

      const tokenData = await exchangeCode(code);
      if (!tokenData?.access_token) throw new Error('Token exchange failed');

      const userInfo = await getUserInfo(tokenData.access_token);
      const email = userInfo?.email;
      if (!email) throw new Error('Could not get email from Google');

      if (!email.endsWith('@' + ALLOWED_DOMAIN)) {
        pending.reject(new Error('Unauthorized domain: ' + email));
        return html(403, `<html><body style="font-family:sans-serif;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><h2>🔒 Access Denied</h2><p style="color:#f87171">${email}</p><p style="color:#64748b">Only @callboxinc.com accounts allowed.</p></div></body></html>`);
      }

      const session = {
        email, access_token: tokenData.access_token, refresh_token: tokenData.refresh_token,
        expires_at: Date.now() + tokenData.expires_in * 1000,
        scopes: pending.scopes, created_at: Date.now(), last_used: Date.now(), _idleTimer: null,
      };
      sessions.set(email, session);
      if (tokenData.refresh_token) saveRefreshToken(email, tokenData.refresh_token);
      touchSession(email);

      completedCallbacks.set(state, { email, ts: Date.now() });
      setTimeout(() => completedCallbacks.delete(state), 60000);
      pending.resolve({ email, session });

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

  res.writeHead(404);
  res.end('Not found');
});

// Load redirect URI from DB before starting
loadRedirectUriFromDb().then(() => server.listen(PORT, '127.0.0.1', () => {
  console.log(`[google-auth] Running on http://127.0.0.1:${PORT}`);
  console.log(`[google-auth] Callback: ${REDIRECT_URI}`);
  console.log(`[google-auth] Token store: ${TOKEN_DIR}`);
  if (REDIRECT_URI.includes('YOUR_VM_DOMAIN')) {
    console.warn('[google-auth] ⚠️  REDIRECT_URI not set — update skill callback \'oauth-callback\' in /knowledge dashboard');
  }
}));

process.on('uncaughtException', err => console.error('[google-auth] Uncaught:', err.message));
process.on('unhandledRejection', reason => console.error('[google-auth] Unhandled:', reason));
