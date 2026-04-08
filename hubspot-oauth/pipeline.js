'use strict';

/**
 * Pipeline API Client
 * Handles token lifecycle + employee lookup for scope resolution
 */

const https = require('https');
const http  = require('http');

const PIPELINE_URL    = process.env.PIPELINE_API_URL   || 'http://192.168.50.34:8000';
const AGENT_ID        = process.env.PIPELINE_AGENT_ID  || 'brian';
const DEPT            = process.env.PIPELINE_DEPT       || 'dev';
const ADMIN_SECRET    = process.env.PIPELINE_SECRET     || '';
const TOKEN_TTL_MS    = 23 * 60 * 60 * 1000; // refresh every 23h (expires 24h)

let _token      = null;
let _tokenAt    = 0;
let _refreshing = false;

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url   = new URL(PIPELINE_URL + path);
    const isSSL = url.protocol === 'https:';
    const lib   = isSSL ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isSSL ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Pipeline API parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Token management ─────────────────────────────────────────────────────────

async function fetchToken() {
  const data = await request('POST', '/auth/token', {
    agent_id:     AGENT_ID,
    dept:         DEPT,
    admin_secret: ADMIN_SECRET,
  });
  if (!data.token) throw new Error(`Pipeline auth failed: ${JSON.stringify(data)}`);
  return data.token;
}

async function getToken() {
  const age = Date.now() - _tokenAt;
  if (_token && age < TOKEN_TTL_MS) return _token;
  if (_refreshing) {
    // Wait for ongoing refresh
    await new Promise(r => setTimeout(r, 500));
    return _token;
  }
  _refreshing = true;
  try {
    _token   = await fetchToken();
    _tokenAt = Date.now();
    console.log('[pipeline] Token refreshed successfully');
  } catch (err) {
    console.error('[pipeline] Token refresh failed:', err.message);
    throw err;
  } finally {
    _refreshing = false;
  }
  return _token;
}

// Auto-refresh every 23h
setInterval(async () => {
  try { await getToken(); }
  catch (err) { console.error('[pipeline] Auto-refresh failed:', err.message); }
}, TOKEN_TTL_MS);

// ─── Employee lookup ──────────────────────────────────────────────────────────

const _employeeCache = new Map(); // email → { data, ts }
const CACHE_TTL = 5 * 60 * 1000; // 5 min

async function lookupEmployee(email) {
  const cacheKey = email.toLowerCase();
  const cached = _employeeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const token = await getToken();
  const data  = await request('GET', `/api/employee/lookup?email=${encodeURIComponent(email)}`, null, token);
  if (!data.ok) return null;

  const result = {
    employee_id: data.employee.employee_id,
    user_id:     data.employee.user_id,
    name:        data.employee.name,
    email:       data.employee.email,
    position:    data.employee.position?.name || null,
    status:      data.employee.status,
    roles:       (data.roles || []).filter(r => r.role_status === 'active').map(r => r.role_name),
  };

  _employeeCache.set(cacheKey, { data: result, ts: Date.now() });
  return result;
}

// ─── HubSpot scope resolution ─────────────────────────────────────────────────

const BASE_SCOPES = [
  'oauth',
  'crm.objects.contacts.read',
  'crm.objects.deals.read',
  'crm.objects.companies.read',
  'crm.objects.owners.read',
  'crm.objects.custom.read',
  'crm.lists.read',
];

const WRITE_CONTACTS   = 'crm.objects.contacts.write';
const WRITE_DEALS      = 'crm.objects.deals.write';
const WRITE_COMPANIES  = 'crm.objects.companies.write';
const WRITE_LISTS      = 'crm.lists.write';
const WRITE_CUSTOM     = 'crm.objects.custom.write';
// const EXPORT           = 'crm.export';  // removed
// const IMPORT           = 'crm.import';  // removed

// Position → additional scopes
const POSITION_SCOPES = {
  // C-level / VP / Director
  'CEO':                              [WRITE_CONTACTS, WRITE_DEALS, WRITE_COMPANIES, WRITE_LISTS, WRITE_CUSTOM],
  'Sales and Marketing VP':           [WRITE_CONTACTS, WRITE_DEALS, WRITE_COMPANIES, WRITE_LISTS, WRITE_CUSTOM],
  'VP for Operations and IT':         [WRITE_CONTACTS, WRITE_DEALS, WRITE_COMPANIES, WRITE_LISTS, WRITE_CUSTOM],
  'VP for Business Development and Partnerships': [WRITE_CONTACTS, WRITE_DEALS, WRITE_COMPANIES, WRITE_LISTS, WRITE_CUSTOM],
  'HR/Admin and Finance Director':    [WRITE_CONTACTS, WRITE_DEALS, WRITE_COMPANIES, WRITE_LISTS, WRITE_CUSTOM],
  'Director':                         [WRITE_CONTACTS, WRITE_DEALS, WRITE_COMPANIES, WRITE_LISTS, WRITE_CUSTOM],

  // Manager / Senior Lead Dev / IT
  'Operations Manager':               [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS, WRITE_CUSTOM],
  'Business Development Manager':     [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS],
  'CRM Manager':                      [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS, WRITE_CUSTOM],
  'IT Manager':                       [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS, WRITE_CUSTOM],
  'Finance Manager':                  [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS],
  'HR/Admin Manager':                 [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS],
  'Marketing Manager':                [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS],
  'Senior Lead Developer':            [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS, WRITE_CUSTOM],
  'Cloud & AI Solutions Architect':   [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS, WRITE_CUSTOM],
  'Manager':                          [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS],

  // Team Lead / Senior CSM / Sr PM
  'Senior Client Success Manager':    [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS],
  'Senior Production Manager':        [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS],
  'Database Management Team Leader':  [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS],

  // CSM / PM
  'Client Success Manager':           [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS],
  'Production Manager':               [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS],
  'Associate Production Manager':     [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS],
  'Junior Production Manager':        [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS],
  'Junior Client Success Manager':    [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS],

  // Sales
  'Business Development Representative': [WRITE_DEALS, WRITE_LISTS],

  // BD Rep
  'SEO Program Manager':              [WRITE_CONTACTS, WRITE_LISTS],
  'Digital Marketing Manager':        [WRITE_CONTACTS, WRITE_LISTS],
  'Global Digital Marketing Manager': [WRITE_CONTACTS, WRITE_LISTS],
  'Event Manager':                    [WRITE_CONTACTS, WRITE_LISTS],

  // SMM / Content Writer → base only
  'Junior Social Media Specialist':   [],
  'Associate Social Media Specialist':[],
  'Senior Social Media Specialist':   [],
  'Junior Content Writer':            [],
  'Associate Content Writer':         [],
  'Email Marketing Associate':        [],
  'Email Marketing Specialist':       [],
  'Junior Digital Designer':          [],
  'Graphic Designer':                 [],
  'Senior Digital Designer':          [],

  // Finance → deals.write only
  'Finance Associate':                [WRITE_DEALS],
  'Finance Specialist':               [WRITE_DEALS],

  // Default / Trainee → base only
  'Trainee':                          [],
};

// Role → additional scopes (merged on top of position)
const ROLE_SCOPES = {
  'system_developer': [WRITE_CONTACTS, WRITE_DEALS, WRITE_LISTS, WRITE_CUSTOM],
  'crm_manager':      [WRITE_CONTACTS, WRITE_COMPANIES, WRITE_LISTS],
  'research_head':    [],
};

async function resolveHubSpotScopes(email) {
  try {
    const employee = await lookupEmployee(email);
    if (!employee) {
      console.log(`[pipeline] Employee not found for ${email} — using base scopes`);
      return { scopes: BASE_SCOPES, position: null, roles: [] };
    }

    const position = employee.position || '';
    const roles    = employee.roles || [];

    // Position-based scopes
    const positionExtra = POSITION_SCOPES[position] || [];

    // Role-based additional scopes
    const roleExtra = roles.flatMap(r => ROLE_SCOPES[r] || []);

    // Merge all, deduplicate
    const allScopes = [...new Set([...BASE_SCOPES, ...positionExtra, ...roleExtra])];

    console.log(`[pipeline] Resolved scopes for ${email} (${position}): ${allScopes.join(', ')}`);

    return {
      scopes:   allScopes,
      position: position,
      roles:    roles,
      employee: {
        name:        employee.name,
        employee_id: employee.employee_id,
        user_id:     employee.user_id,
      },
    };
  } catch (err) {
    console.error(`[pipeline] Scope resolution failed for ${email}: ${err.message}`);
    return { scopes: BASE_SCOPES, position: null, roles: [] };
  }
}

module.exports = { lookupEmployee, resolveHubSpotScopes, getToken };
