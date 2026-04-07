/**
 * HubSpot OAuth Server — Per-User, Multi-Portal Token Management
 * Ported from macOS to Linux LXC fleet — file-based token storage (replaces macOS Keychain)
 *
 * Port: 19002
 * Callback: https://oc.callboxinc.ai/hubspot-auth/callback
 *
 * Supported Portals:
 *   4950628  — Callbox Marketing (MarketingCRM)
 *   21203560 — OneCRM
 */

'use strict';

const http   = require('http');
const https  = require('https');
const url    = require('url');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const PORT         = 19002;
const REDIRECT_URI = process.env.HUBSPOT_REDIRECT_URI || 'https://oc.callboxinc.ai/hubspot-auth/callback';
const HS_AUTH_URL  = 'https://app.hubspot.com/oauth/authorize';
const HS_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';

const TOKEN_DIR = process.env.TOKEN_STORE_DIR || '/home/dev-user/.callbox-hubspot-tokens';
const ORG_ID    = 'f86d92cb-db10-43ff-9ff2-d69c319d272d';

// Known portals
const KNOWN_PORTALS = {
  '4950628':  'Callbox Marketing (MarketingCRM)',
  '21203560': 'OneCRM',
};

// In-memory session store: "email:hub_id" → session object
const sessions = new Map();

// Pending OAuth flows: state → { resolve, timer, portal_id? }
const pendingAuths = new Map();

const SESSION_IDLE_MS          = 60 * 60 * 1000;
const REFRESH_TOKEN_MAX_AGE_MS = 25 * 24 * 60 * 60 * 1000;

const REQUIRED_SCOPES         = 'oauth crm.objects.contacts.read crm.objects.deals.read crm.objects.companies.read crm.objects.owners.read crm.objects.custom.read crm.lists.read';
const DEFAULT_OPTIONAL_SCOPES = [];
const PORTAL_SCOPE_PRESETS    = { '4950628': [], '21203560': [] };
const ROLE_SCOPE_ADDITIONS    = { 'org': [], 'team': [], 'owner': [] };

// ─── Credentials ──────────────────────────────────────────────────────────────

function getClientId()     { return process.env.HUBSPOT_CLIENT_ID; }
function getClientSecret() { return process.env.HUBSPOT_CLIENT_SECRET; }

// ─── Token storage — DB-first, file fallback ──────────────────────────────────

const { Pool } = require('pg');
const dbPool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev' });

function keychainTokenKey(email, hubId) {
  return path.join(TOKEN_DIR, `${email}-${hubId}.token`);
}

async function saveRefreshToken(email, hubId, refreshToken, extra = {}) {
  try {
    const acct = await dbPool.query(
      `SELECT id FROM fleet.accounts WHERE email=$1 AND org_id=$2`, [email, ORG_ID]
    );
    if (!acct.rows.length) throw new Error(`Account not found: ${email}`);
    const account_id = acct.rows[0].id;
    const scopes = extra.scopes || [];
    const credentials = JSON.stringify({ refresh_token: refreshToken, issued_at: Date.now(), hub_id: hubId });
    const meta = JSON.stringify({ hub_id: hubId, portal_name: KNOWN_PORTALS[hubId] || `Portal ${hubId}`, owner_id: extra.owner_id || null, user_id: extra.user_id || null, email });
    await dbPool.query(`
      INSERT INTO fleet.user_integrations (org_id, account_id, integration, portal_id, enabled, scopes, credentials, meta)
      VALUES ($1,$2,'hubspot',$3,true,$4,$5,$6)
      ON CONFLICT (org_id, account_id, integration, portal_id) DO UPDATE SET
        credentials=EXCLUDED.credentials,
        scopes=CASE WHEN array_length(EXCLUDED.scopes,1)>0 THEN EXCLUDED.scopes ELSE fleet.user_integrations.scopes END,
        meta=EXCLUDED.meta, enabled=true, updated_at=now()
    `, [ORG_ID, account_id, String(hubId), scopes, credentials, meta]);
    console.log(`[hubspot-oauth] Refresh token saved to DB for ${email} (portal: ${hubId})`);
  } catch (err) {
    console.error(`[hubspot-oauth] DB save failed, falling back to file: ${err.message}`);
    try { fs.mkdirSync(TOKEN_DIR, { recursive: true }); fs.writeFileSync(keychainTokenKey(email, hubId), JSON.stringify({ token: refreshToken, issued_at: Date.now(), hub_id: hubId })); } catch {}
  }
}

async function loadRefreshToken(email, hubId) {
  try {
    const result = await dbPool.query(
      `SELECT ui.credentials, ui.created_at FROM fleet.user_integrations ui
       JOIN fleet.accounts a ON a.id=ui.account_id
       WHERE a.email=$1 AND ui.integration='hubspot' AND ui.portal_id=$2 AND ui.enabled=true AND ui.org_id=$3`,
      [email, String(hubId), ORG_ID]
    );
    if (result.rows.length) {
      const creds = result.rows[0].credentials;
      const token = creds.refresh_token || creds.token || null;
      const issued_at = creds.issued_at || Date.parse(result.rows[0].created_at);
      const age = Date.now() - issued_at;
      if (age > REFRESH_TOKEN_MAX_AGE_MS) return null;
      return { token, issued_at, age_days: Math.floor(age / 86400000) };
    }
  } catch (err) { console.error(`[hubspot-oauth] DB load failed: ${err.message}`); }
  // File fallback + auto-migrate
  try {
    const raw = JSON.parse(fs.readFileSync(keychainTokenKey(email, hubId), 'utf8'));
    const age = Date.now() - raw.issued_at;
    if (age > REFRESH_TOKEN_MAX_AGE_MS) return null;
    await saveRefreshToken(email, hubId, raw.token);
    try { fs.unlinkSync(keychainTokenKey(email, hubId)); } catch {}
    return { token: raw.token, issued_at: raw.issued_at, age_days: Math.floor(age / 86400000) };
  } catch { return null; }
}

async function loadRefreshTokenLegacy(email) {
  try {
    const result = await dbPool.query(
      `SELECT ui.credentials FROM fleet.user_integrations ui
       JOIN fleet.accounts a ON a.id=ui.account_id
       WHERE a.email=$1 AND ui.integration='hubspot' AND ui.enabled=true AND ui.org_id=$2
       ORDER BY ui.updated_at DESC LIMIT 1`,
      [email, ORG_ID]
    );
    if (result.rows.length) {
      const creds = result.rows[0].credentials;
      return { token: creds.refresh_token || creds.token, issued_at: creds.issued_at, age_days: null };
    }
  } catch {}
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(TOKEN_DIR, `${email}.token`), 'utf8'));
    if (raw.token) return { token: raw.token, issued_at: raw.issued_at, age_days: null };
  } catch {}
  return null;
}

async function deleteRefreshToken(email, hubId) {
  try {
    await dbPool.query(
      `UPDATE fleet.user_integrations ui SET enabled=false, updated_at=now()
       FROM fleet.accounts a WHERE a.id=ui.account_id AND a.email=$1 AND ui.integration='hubspot' AND ui.portal_id=$2 AND ui.org_id=$3`,
      [email, String(hubId), ORG_ID]
    );
    console.log(`[hubspot-oauth] Token disabled in DB for ${email} (portal: ${hubId})`);
  } catch (err) { console.error(`[hubspot-oauth] DB delete failed: ${err.message}`); }
  try { fs.unlinkSync(keychainTokenKey(email, hubId)); } catch {}
}

// ─── Session key helpers ──────────────────────────────────────────────────────

function sessionKey(email, hubId) {
  return `${email}:${hubId}`;
}

// ─── Session management ───────────────────────────────────────────────────────

function touchSession(email, hubId) {
  const key = sessionKey(email, hubId);
  const s = sessions.get(key);
  if (!s) return;
  if (s._idleTimer) clearTimeout(s._idleTimer);
  s.last_used = Date.now();
  s._idleTimer = setTimeout(() => {
    console.log(`[hubspot-oauth] Session idle timeout: ${email} (portal: ${hubId})`);
    destroySession(email, hubId);
  }, SESSION_IDLE_MS);
}

function destroySession(email, hubId, { revokeKeychain = false } = {}) {
  const key = sessionKey(email, hubId);
  const s = sessions.get(key);
  if (s?._idleTimer) clearTimeout(s._idleTimer);
  sessions.delete(key);
  if (revokeKeychain) deleteRefreshToken(email, hubId);
  console.log(`[hubspot-oauth] Session destroyed: ${email} (portal: ${hubId})${revokeKeychain ? ' (token file cleared)' : ''}`);
}

function getSession(email, hubId) {
  if (!hubId) {
    for (const [k, v] of sessions) {
      if (k.startsWith(email + ':')) {
        touchSession(email, v.hub_id);
        return v;
      }
    }
    return null;
  }
  const s = sessions.get(sessionKey(email, hubId));
  if (!s) return null;
  touchSession(email, hubId);
  return s;
}

function getSessionsForEmail(email) {
  const result = [];
  for (const [k, v] of sessions) {
    if (k.startsWith(email + ':')) result.push(v);
  }
  return result;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
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

function httpsGet(hostname, path, accessToken) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method: 'GET', headers: {} };
    if (accessToken) opts.headers['Authorization'] = `Bearer ${accessToken}`;
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Token exchange & refresh ─────────────────────────────────────────────────

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     getClientId(),
    client_secret: getClientSecret(),
    redirect_uri:  REDIRECT_URI,
    code,
  }).toString();
  return httpsPost('api.hubapi.com', '/oauth/v1/token', body);
}

async function refreshAccessToken(email, hubId, refreshToken) {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     getClientId(),
    client_secret: getClientSecret(),
    refresh_token: refreshToken,
  }).toString();
  const data = await httpsPost('api.hubapi.com', '/oauth/v1/token', body);
  if (data.access_token) {
    const s = sessions.get(sessionKey(email, hubId));
    if (s) {
      s.access_token = data.access_token;
      s.expires_at   = Date.now() + (data.expires_in || 1800) * 1000;
      if (data.refresh_token) {
        s.refresh_token = data.refresh_token;
        saveRefreshToken(email, hubId, data.refresh_token);
      }
      touchSession(email, hubId);
    }
    return data.access_token;
  }
  throw new Error('Token refresh failed: ' + JSON.stringify(data));
}

async function getValidToken(email, hubId) {
  const key = sessionKey(email, hubId);
  let s = sessions.get(key);

  if (!s) {
    let stored = loadRefreshToken(email, hubId);
    if (!stored) stored = loadRefreshTokenLegacy(email);
    if (!stored) return null;
    s = {
      email,
      hub_id: String(hubId),
      refresh_token: stored.token,
      refresh_token_issued_at: stored.issued_at,
      refresh_token_age_days:  stored.age_days,
      access_token: null,
      expires_at: 0,
    };
    sessions.set(key, s);
  }

  if (s.refresh_token_issued_at) {
    const age = Date.now() - s.refresh_token_issued_at;
    if (age > REFRESH_TOKEN_MAX_AGE_MS) {
      console.log(`[hubspot-oauth] Refresh token for ${email}:${hubId} is stale — expiring`);
      destroySession(email, hubId, { revokeKeychain: true });
      return null;
    }
  }

  const isStartupWindow = Date.now() - SERVER_START_TIME < STARTUP_REFRESH_WINDOW_MS;
  const needsRefresh = !s.access_token || Date.now() >= s.expires_at - 60000 || isStartupWindow;

  if (needsRefresh) {
    if (!s.refresh_token) {
      console.log(`[hubspot-oauth] No refresh token for ${email}:${hubId} — re-auth required`);
      return null;
    }
    try {
      console.log(`[hubspot-oauth] Refreshing access token for ${email}:${hubId}${isStartupWindow ? ' (startup refresh)' : ''}`);
      await refreshAccessToken(email, hubId, s.refresh_token);
      s = sessions.get(key);
      console.log(`[hubspot-oauth] Access token refreshed successfully for ${email}:${hubId}`);
    } catch (err) {
      console.error(`[hubspot-oauth] Token refresh FAILED for ${email}:${hubId}: ${err.message}`);
      destroySession(email, hubId, { revokeKeychain: true });
      return null;
    }
  }

  if (!s?.access_token) {
    console.log(`[hubspot-oauth] No access token after refresh attempt for ${email}:${hubId}`);
    return null;
  }

  touchSession(email, hubId);
  return s.access_token;
}

async function fetchOwnerByEmail(accessToken, email) {
  try {
    const data = await httpsGet('api.hubapi.com', `/crm/v3/owners?email=${encodeURIComponent(email)}&limit=1`, accessToken);
    return data?.results?.[0] || null;
  } catch {
    return null;
  }
}

async function fetchUserPermissions(accessToken, userId) {
  try {
    const data = await httpsGet('api.hubapi.com', `/settings/v3/users/${userId}`, accessToken);
    return {
      roleId:           data?.roleId || null,
      roleName:         data?.roleName || null,
      superAdmin:       data?.superAdmin || false,
      permissionSets:   data?.permissionSets || [],
      primaryTeamId:    data?.primaryTeamId || null,
      secondaryTeamIds: data?.secondaryTeamIds || [],
    };
  } catch {
    return null;
  }
}

// ─── Request handler ──────────────────────────────────────────────────────────

async function handler(req, res) {
  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;
  const query  = parsed.query;

  res.setHeader('Content-Type', 'application/json');

  // ── GET /health ─────────────────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
    return;
  }

  // ── POST /auth/request ──────────────────────────────────────────────────────
  if (req.method === 'POST' && path === '/auth/request') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { timeout_ms = 120000, portal_id, scopes, role } = JSON.parse(body || '{}');
        const state    = crypto.randomBytes(16).toString('hex');
        const clientId = getClientId();

        let optionalScopes;
        if (Array.isArray(scopes) && scopes.length > 0) {
          optionalScopes = scopes;
        } else if (portal_id && PORTAL_SCOPE_PRESETS[String(portal_id)]) {
          optionalScopes = [...PORTAL_SCOPE_PRESETS[String(portal_id)]];
        } else {
          optionalScopes = [...DEFAULT_OPTIONAL_SCOPES];
        }
        if (role && ROLE_SCOPE_ADDITIONS[role]) {
          optionalScopes = [...new Set([...optionalScopes, ...ROLE_SCOPE_ADDITIONS[role]])];
        }

        const authUrl = `${HS_AUTH_URL}?` + new URLSearchParams({
          client_id:      clientId,
          redirect_uri:   REDIRECT_URI,
          scope:          REQUIRED_SCOPES,
          optional_scope: optionalScopes.join(' '),
          state,
        }).toString();

        const timer = setTimeout(() => {
          const p = pendingAuths.get(state);
          if (p) { p.resolve({ status: 'expired' }); pendingAuths.delete(state); }
        }, timeout_ms);

        pendingAuths.set(state, {
          portal_id: portal_id ? String(portal_id) : null,
          resolve: (result) => {
            clearTimeout(timer);
            pendingAuths.delete(state);
            pendingAuths.set(`result:${state}`, { ...result, ts: Date.now() });
          },
          timer,
        });

        res.writeHead(200);
        res.end(JSON.stringify({ auth_url: authUrl, state, portal_id: portal_id || null }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── GET /hubspot-auth/callback ──────────────────────────────────────────────
  if (req.method === 'GET' && (path === '/hubspot-auth/callback' || path === '/callback')) {
    const { code, state, error } = query;

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Auth Failed</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px">
<h2>❌ Authentication Failed</h2><p>${error}</p><p style="color:#999">You can close this tab.</p>
<p style="color:#ccc;margin-top:40px">CALLBOX AI</p></body></html>`);
      const p = pendingAuths.get(state);
      if (p) p.resolve({ status: 'error', error });
      return;
    }

    try {
      const tokens = await exchangeCode(code);
      if (!tokens.access_token) throw new Error('No access token in response');

      let email = null, hubId = null, userId = null, grantedScopes = [];
      try {
        const info = await httpsGet('api.hubapi.com', `/oauth/v1/access-tokens/${tokens.access_token}`, null);
        email  = info.user;
        hubId  = String(info.hub_id);
        userId = info.user_id;
        grantedScopes = info.scopes || [];
      } catch (e) {
        console.error('[hubspot-oauth] Failed to fetch token info:', e.message);
      }

      if (!email) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>❌ Could not determine user email from HubSpot token.</h2></body></html>');
        return;
      }

      const pending = pendingAuths.get(state);
      const requestedPortal = pending?.portal_id;
      if (requestedPortal && requestedPortal !== hubId) {
        console.warn(`[hubspot-oauth] Portal mismatch: requested ${requestedPortal}, got ${hubId} for ${email}`);
      }

      const ownerRecord = await fetchOwnerByEmail(tokens.access_token, email);
      const ownerId = ownerRecord?.id || null;
      const portalName = KNOWN_PORTALS[hubId] || `Portal ${hubId}`;
      const permissions = userId ? await fetchUserPermissions(tokens.access_token, userId) : null;

      const now = Date.now();
      const session = {
        email,
        hub_id:                   hubId,
        user_id:                  userId,
        owner_id:                 ownerId,
        portal_name:              portalName,
        scopes:                   grantedScopes,
        can_read_contacts:        grantedScopes.includes('crm.objects.contacts.read'),
        can_read_deals:           grantedScopes.includes('crm.objects.deals.read'),
        can_read_companies:       grantedScopes.includes('crm.objects.companies.read'),
        can_read_custom:          grantedScopes.includes('crm.objects.custom.read'),
        permissions,
        access_token:             tokens.access_token,
        refresh_token:            tokens.refresh_token,
        refresh_token_issued_at:  now,
        refresh_token_age_days:   0,
        expires_at:               now + (tokens.expires_in || 1800) * 1000,
        last_used:                now,
      };
      sessions.set(sessionKey(email, hubId), session);
      touchSession(email, hubId);

      if (tokens.refresh_token) saveRefreshToken(email, hubId, tokens.refresh_token);

      console.log(`[hubspot-oauth] Authenticated: ${email} (hub: ${hubId} — ${portalName}, owner: ${ownerId})`);

      if (pending) pending.resolve({ status: 'authenticated', email, hub_id: hubId, portal_name: portalName, owner_id: ownerId });

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HubSpot Connected — Callbox AI</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f6f9; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 16px; padding: 48px 40px; max-width: 420px; width: 90%; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .icon { width: 72px; height: 72px; background: #e6f9f0; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px; font-size: 36px; }
    h1 { font-size: 22px; font-weight: 700; color: #1a1a2e; margin-bottom: 8px; }
    .subtitle { font-size: 14px; color: #6b7280; margin-bottom: 24px; }
    .badge { display: inline-flex; align-items: center; gap: 8px; background: #f0f4ff; border: 1px solid #dde3f5; border-radius: 32px; padding: 8px 16px; font-size: 14px; color: #3b4cca; font-weight: 500; margin-bottom: 8px; }
    .portal-badge { display: inline-flex; align-items: center; gap: 8px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 32px; padding: 6px 14px; font-size: 13px; color: #c2410c; font-weight: 500; margin-bottom: 24px; }
    .meta { font-size: 12px; color: #9ca3af; line-height: 1.8; }
    .divider { border: none; border-top: 1px solid #f0f0f0; margin: 24px 0; }
    .close-hint { font-size: 13px; color: #9ca3af; }
    .logo { font-size: 13px; color: #d1d5db; margin-top: 32px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>HubSpot Connected</h1>
    <p class="subtitle">Your account has been linked to Callbox AI.</p>
    <div class="badge">🔐 ${email}</div><br>
    <div class="portal-badge">🏢 ${portalName} (${hubId})</div>
    <div class="meta">
      <span>Owner ID: ${ownerId || 'N/A'}</span>
      <span>Token valid for ~25 days</span>
    </div>
    <hr class="divider">
    <p class="close-hint">You can close this tab and return to the chat. 🐝</p>
    <p class="logo">CALLBOX AI</p>
  </div>
</body>
</html>`);
    } catch (err) {
      console.error('[hubspot-oauth] Callback error:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h2>❌ Error: ${err.message}</h2></body></html>`);
      const p = pendingAuths.get(state);
      if (p) p.resolve({ status: 'error', error: err.message });
    }
    return;
  }

  // ── GET /auth/status ────────────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/auth/status') {
    const { state, email, portal_id } = query;

    if (state) {
      const result = pendingAuths.get(`result:${state}`);
      if (result) { res.writeHead(200); res.end(JSON.stringify(result)); return; }
      const pending = pendingAuths.get(state);
      res.writeHead(200);
      res.end(JSON.stringify({ status: pending ? 'pending' : 'expired' }));
      return;
    }

    if (email) {
      if (portal_id) {
        const s = getSession(email, portal_id);
        if (s) {
          const tokenAgeDays = s.refresh_token_issued_at ? Math.floor((Date.now() - s.refresh_token_issued_at) / 86400000) : null;
          const tokenExpiresInDays = s.refresh_token_issued_at ? Math.floor((REFRESH_TOKEN_MAX_AGE_MS - (Date.now() - s.refresh_token_issued_at)) / 86400000) : null;
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'authenticated', email: s.email, hub_id: s.hub_id, portal_name: s.portal_name, owner_id: s.owner_id, token_age_days: tokenAgeDays, token_expires_in_days: tokenExpiresInDays }));
          return;
        }
        const stored = loadRefreshToken(email, portal_id);
        res.writeHead(200);
        res.end(JSON.stringify({ status: stored ? 'restorable' : 'unauthenticated', reauth_required: !stored, email, hub_id: portal_id, portal_name: KNOWN_PORTALS[portal_id] || `Portal ${portal_id}`, token_age_days: stored?.age_days ?? null }));
        return;
      }

      const activeSessions = getSessionsForEmail(email);
      if (activeSessions.length > 0) {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'authenticated',
          email,
          portals: activeSessions.map(s => ({
            hub_id: s.hub_id,
            portal_name: s.portal_name || KNOWN_PORTALS[s.hub_id],
            owner_id: s.owner_id,
          })),
        }));
        return;
      }
      const portals = [];
      for (const [pid, pname] of Object.entries(KNOWN_PORTALS)) {
        const stored = loadRefreshToken(email, pid);
        if (stored) portals.push({ hub_id: pid, portal_name: pname, status: 'restorable', token_age_days: stored.age_days });
      }
      const legacy = loadRefreshTokenLegacy(email);
      res.writeHead(200);
      res.end(JSON.stringify({
        status: portals.length > 0 || legacy ? 'restorable' : 'unauthenticated',
        email,
        portals,
        legacy_token: !!legacy,
        reauth_required: portals.length === 0 && !legacy,
      }));
      return;
    }

    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Provide state or email' }));
    return;
  }

  // ── GET /sessions ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/sessions') {
    const { email } = query;
    if (!email) { res.writeHead(400); res.end(JSON.stringify({ error: 'email required' })); return; }
    const activeSessions = getSessionsForEmail(email);
    res.writeHead(200);
    res.end(JSON.stringify({
      email,
      sessions: activeSessions.map(s => ({
        hub_id: s.hub_id,
        portal_name: s.portal_name || KNOWN_PORTALS[s.hub_id],
        owner_id: s.owner_id,
        last_used: s.last_used,
      })),
    }));
    return;
  }

  // ── GET /token ──────────────────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/token') {
    const { email, portal_id } = query;
    if (!email) { res.writeHead(400); res.end(JSON.stringify({ error: 'email required' })); return; }
    if (!portal_id) { res.writeHead(400); res.end(JSON.stringify({ error: 'portal_id required (4950628 or 21203560)' })); return; }

    try {
      const token = await getValidToken(email, portal_id);
      if (!token) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Authentication required', reason: 'not_authenticated', reauth_required: true, email, portal_id, portal_name: KNOWN_PORTALS[portal_id] || `Portal ${portal_id}` }));
        return;
      }
      const s = sessions.get(sessionKey(email, portal_id));
      const tokenAgeDays = s?.refresh_token_issued_at ? Math.floor((Date.now() - s.refresh_token_issued_at) / 86400000) : null;
      const tokenExpiresInDays = s?.refresh_token_issued_at ? Math.floor((REFRESH_TOKEN_MAX_AGE_MS - (Date.now() - s.refresh_token_issued_at)) / 86400000) : null;
      res.writeHead(200);
      res.end(JSON.stringify({
        access_token:          token,
        email:                 s?.email,
        portal_id,
        portal_name:           s?.portal_name || KNOWN_PORTALS[portal_id],
        owner_id:              s?.owner_id,
        hub_id:                s?.hub_id || portal_id,
        scopes:                s?.scopes || [],
        can_read_contacts:     s?.scopes?.includes('crm.objects.contacts.read') ?? s?.can_read_contacts ?? true,
        can_read_deals:        s?.scopes?.includes('crm.objects.deals.read') ?? s?.can_read_deals ?? false,
        can_read_companies:    s?.scopes?.includes('crm.objects.companies.read') ?? s?.can_read_companies ?? false,
        can_read_custom:       s?.scopes?.includes('crm.objects.custom.read') ?? false,
        permissions:           s?.permissions || null,
        token_age_days:        tokenAgeDays,
        token_expires_in_days: tokenExpiresInDays,
      }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── POST /session/destroy ───────────────────────────────────────────────────
  if (req.method === 'POST' && path === '/session/destroy') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { email, portal_id, revoke_keychain = false } = JSON.parse(body || '{}');
        if (!email) { res.writeHead(400); res.end(JSON.stringify({ error: 'email required' })); return; }
        if (portal_id) {
          destroySession(email, portal_id, { revokeKeychain: revoke_keychain });
        } else {
          for (const [pid] of Object.entries(KNOWN_PORTALS)) destroySession(email, pid, { revokeKeychain: revoke_keychain });
        }
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'destroyed', email, portal_id: portal_id || 'all' }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ─── Start server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  handler(req, res).catch(err => {
    console.error('[hubspot-oauth] Unhandled error:', err);
    try { res.writeHead(500); res.end(JSON.stringify({ error: 'Internal server error' })); } catch {}
  });
});

const SERVER_START_TIME = Date.now();
const STARTUP_REFRESH_WINDOW_MS = 30 * 1000;

// Proactive token refresh every 4 hours
setInterval(async () => {
  try {
    for (const [key, session] of sessions.entries()) {
      if (!session.refresh_token) continue;
      const { email, hub_id, refresh_token_issued_at } = session;
      const age = Date.now() - (refresh_token_issued_at || 0);
      if (age > 4 * 60 * 60 * 1000) {
        try {
          console.log(`[hubspot-oauth] Proactive refresh: ${email}:${hub_id} (age: ${Math.round(age / 3600000)}h)`);
          await refreshAccessToken(email, hub_id, session.refresh_token);
        } catch (err) {
          console.error(`[hubspot-oauth] Proactive refresh failed for ${email}:${hub_id}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error('[hubspot-oauth] Proactive refresh task error:', err.message);
  }
}, 4 * 60 * 60 * 1000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[hubspot-oauth] Server listening on http://127.0.0.1:${PORT}`);
  console.log(`[hubspot-oauth] Callback URL: ${REDIRECT_URI}`);
  console.log(`[hubspot-oauth] Token store: ${TOKEN_DIR}`);
  console.log(`[hubspot-oauth] Supported portals: ${Object.entries(KNOWN_PORTALS).map(([id,n]) => `${n} (${id})`).join(', ')}`);
});

process.on('SIGTERM', () => { console.log('[hubspot-oauth] Shutting down...'); server.close(); });
process.on('SIGINT',  () => { console.log('[hubspot-oauth] Shutting down...'); server.close(); });
