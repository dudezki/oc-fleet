import express from 'express';
import axios from 'axios';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';

const app = express();
app.use(express.json());

const PORT = 19003;
const OAUTH_BASE = 'http://127.0.0.1:19002';
const HUBSPOT_API = 'https://api.hubapi.com';

const ROUTING_TABLE_PATH  = process.env.ROUTING_TABLE_PATH || '/home/dev-user/Projects/oc-fleet/hubspot-proxy/routing-table.json';
const PROXY_DIR           = process.env.PROXY_DIR || '/home/dev-user/Projects/oc-fleet/hubspot-proxy';
const ACCESS_REGISTRY_PATH = join(PROXY_DIR, 'access-registry.json');
const REPORT_REGISTRY_PATH = join(PROXY_DIR, 'report-registry.json');
const AUDIT_LOG_PATH       = join(PROXY_DIR, 'audit.jsonl');

const KNOWN_PORTALS = {
  MarketingCRM: '4950628',
  OneCRM: '21203560',
};

// --- Phase 2: Position Group Resolution ---

function resolvePositionGroup(email, position, rt) {
  const groups = rt.positionGroups || {};
  const overrides = rt.positionGroupOverrides || {};

  if (overrides[email]) {
    const groupName = overrides[email].positionGroup;
    const group = groups[groupName];
    if (group) return { ...group, _groupName: groupName };
  }

  for (const [groupName, group] of Object.entries(groups)) {
    if (group._status === 'blocked' || group._status === 'deferred') continue;
    if (Array.isArray(group.positions) && group.positions.map(p => p.toLowerCase()).includes((position || '').toLowerCase())) {
      return { ...group, _groupName: groupName };
    }
  }

  return null;
}

function positionToAccessLevel(position) {
  const ORG = new Set(['CEO','Sales and Marketing VP','VP for Operations and IT','VP for Business Development and Partnerships','HR/Admin and Finance Director','Director','Cloud & AI Solutions Architect','Global Digital Marketing Manager','Global Learning and Development Manager','IT Security Manager']);
  const TEAM = new Set(['Operations Manager','Business Development Manager','Senior Client Success Manager','Production Manager','Senior Production Manager','Digital Marketing Manager','SEO Program Manager','Finance Manager','IT Manager','Database Support Manager','CRM Manager','Database Management Team Leader','HR/Admin Manager','Marketing Manager','Business Process Manager','Manager','Senior Lead Developer','Database Coordinator','Event Manager','Project Manager 1','Business Development Representative','Senior Quality Assurance Analyst','Quality Assurance Analyst']);
  if (ORG.has(position)) return 'org';
  if (TEAM.has(position)) return 'team';
  return 'owner';
}

// --- File loaders ---

function loadRoutingTable() {
  return JSON.parse(readFileSync(ROUTING_TABLE_PATH, 'utf8'));
}

function loadAccessRegistry() {
  if (!existsSync(ACCESS_REGISTRY_PATH)) return {};
  return JSON.parse(readFileSync(ACCESS_REGISTRY_PATH, 'utf8'));
}

function loadReportRegistry() {
  if (!existsSync(REPORT_REGISTRY_PATH)) return {};
  return JSON.parse(readFileSync(REPORT_REGISTRY_PATH, 'utf8'));
}

// --- Identity cache (TTL: 5 min per email+portal) ---

const identityCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCacheKey(email, portalId) { return `${email}::${portalId}`; }

function getCached(email, portalId) {
  const key = getCacheKey(email, portalId);
  const entry = identityCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { identityCache.delete(key); return null; }
  return entry.data;
}

function setCache(email, portalId, data) {
  identityCache.set(getCacheKey(email, portalId), { data, ts: Date.now() });
}

// --- Admin tokens from env vars (replaces macOS Keychain) ---

const ADMIN_TOKENS = {
  '4950628':  process.env.HUBSPOT_ADMIN_TOKEN_MARKETING_CRM || null,
  '21203560': process.env.HUBSPOT_ADMIN_TOKEN_ONE_CRM || null,
};

async function getToken(email, portalId) {
  const adminToken = ADMIN_TOKENS[String(portalId)];
  if (adminToken) return adminToken;
  const resp = await axios.get(`${OAUTH_BASE}/token`, { params: { email, portal_id: portalId } });
  return resp.data.access_token || resp.data.token;
}

async function getUserToken(email, portalId) {
  try {
    const resp = await axios.get(`${OAUTH_BASE}/token`, { params: { email, portal_id: portalId } });
    return resp.data.access_token || resp.data.token;
  } catch { return null; }
}

// --- HubSpot owner resolution ---

async function resolveOwner(email, token) {
  const resp = await axios.get(`${HUBSPOT_API}/crm/v3/owners`, {
    params: { email },
    headers: { Authorization: `Bearer ${token}` },
  });
  const owners = resp.data.results || [];
  if (owners.length === 0) return null;
  const owner = owners[0];
  return { ownerId: owner.id, teams: owner.teams || [], primaryTeam: owner.teams?.[0] || null };
}

// --- Full identity resolution ---

async function resolveIdentity(email, portalId) {
  const cached = getCached(email, portalId);
  if (cached) return cached;

  const rt = loadRoutingTable();
  const userDir = rt.userDirectory || {};

  const user = userDir[email];
  if (!user) throw new Error(`User not found in routing table: ${email}`);

  const group = resolvePositionGroup(email, user.position, rt);

  if (!group) {
    throw new Error(`No position group found for ${email} (position: ${user.position}). Access denied.`);
  }

  const allowedPortals = group.portal || [];
  if (allowedPortals.length > 0 && !allowedPortals.includes(String(portalId))) {
    throw new Error(`Portal ${portalId} not authorized for ${email} (group: ${group._groupName}, allowed: ${allowedPortals.join(', ')})`);
  }

  const accessLevel = group.accessLevel || 'owner';
  const canWrite = ['Dev_IT', 'Finance', 'Executive', 'CS_DeptLeads', 'Marketing_GroupLeaders',
    'Sales_GroupLeaders', 'CS_TeamLeaders', 'Sales_Group', 'Marketing_Group'].includes(group._groupName);
  const writeScope = ['Dev_IT', 'Finance', 'Executive'].includes(group._groupName) ? 'any' : 'owned';

  const token = await getToken(email, portalId);

  let ownerId = user.ownerId || null;
  let hubspotTeams = user.hubspotTeams || [];
  let primaryTeam = user.primaryTeam || null;

  if (!ownerId) {
    try {
      const ownerInfo = await resolveOwner(email, token);
      if (ownerInfo) { ownerId = ownerInfo.ownerId; hubspotTeams = ownerInfo.teams; primaryTeam = ownerInfo.primaryTeam; }
    } catch (err) {
      console.error(`Failed to resolve HubSpot owner for ${email}:`, err.message);
    }
  }

  const identity = {
    email, name: user.name, position: user.position, department: user.department,
    branch: user.branch, agent: user.agent, positionGroup: group._groupName,
    accessLevel, allowedPortals, allowedObjects: group.objects || [], topics: group.topics || [],
    canWrite, writeScope, database: group.database || false,
    ownerId, hubspotTeams, primaryTeam, proxyEnabled: true, token,
  };

  setCache(email, portalId, identity);
  return identity;
}

// --- Audit logging ---

function auditLog(entry) {
  try {
    appendFileSync(AUDIT_LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

// --- Owner field maps ---

const POSITION_PRIMARY_OWNER_FIELD = {
  'Junior Production Manager': 'pm_assigned', 'Associate Production Manager': 'pm_assigned',
  'Production Manager': 'pm_assigned', 'Senior Production Manager': 'pm_assigned',
  'Junior Client Success Manager': 'csm_assigned', 'Client Success Manager': 'csm_assigned',
  'Senior Client Success Manager': 'csm_assigned',
  'Junior Social Media Specialist': 'smm_assigned', 'Associate Social Media Specialist': 'smm_assigned',
  'Senior Social Media Specialist': 'smm_assigned', 'Digital Marketing Manager': 'smm_assigned',
  'Junior Content Writer': 'content_writer_assigned', 'Associate Content Writer': 'content_writer_assigned',
  'Email Marketing Associate': 'content_writer_assigned', 'Email Marketing Specialist': 'content_writer_assigned',
  'Junior Digital Designer': 'graphics_designer_assigned', 'Graphic Designer': 'graphics_designer_assigned',
  'Junior Graphic Designer': 'graphics_designer_assigned', 'Senior Digital Designer': 'graphics_designer_assigned',
};

const MULTI_OWNER_FIELDS_BY_PORTAL = {
  '21203560': {
    '2-20106951': ['pm_assigned', 'pm_assigned_2', 'hubspot_owner_id', 'csm_assigned', 'ems_assigned', 'smm_assigned', 'content_writer_assigned', 'graphics_designer_assigned', 'submitted_by', 'lead_source_owner'],
    '2-30963623': ['hubspot_owner_id'],
    'deals': ['hubspot_owner_id', 'pa_owner', 'lead_source_owner', 'client_success_manager_owner', 'owner', 'csm_assigned', 'ems_assigned', 'pm_assigned', 'qa_assigned', 'content_writer_assigned', 'graphics_designer_assigned'],
    'contacts': ['hubspot_owner_id'], 'companies': ['hubspot_owner_id'],
  },
  '4950628': {
    'deals': ['hubspot_owner_id', 'pa_owner', 'lead_source_owner', 'client_success_manager_owner'],
    'contacts': ['hubspot_owner_id'], 'companies': ['hubspot_owner_id'],
  },
};

const MULTI_OWNER_FIELDS = {
  '2-20106951': ['pm_assigned', 'pm_assigned_2', 'hubspot_owner_id', 'csm_assigned', 'ems_assigned', 'smm_assigned', 'content_writer_assigned', 'graphics_designer_assigned', 'submitted_by', 'lead_source_owner'],
  '2-30963623': ['hubspot_owner_id'],
  'deals': ['hubspot_owner_id', 'pa_owner', 'lead_source_owner', 'client_success_manager_owner'],
  'contacts': ['hubspot_owner_id'], 'companies': ['hubspot_owner_id'],
};

const DEFAULT_DATE_FIELD = {
  '2-20106951': 'hs_createdate', '2-30963623': 'hs_createdate',
  'deals': 'hs_createdate', 'contacts': 'hs_createdate', 'companies': 'hs_createdate',
};

function buildOwnershipFilterGroups(identity, objectType, additionalFilters = [], portalId = null) {
  const accessLevel = identity.accessOverride || identity.accessLevel;

  if (accessLevel === 'org') {
    return additionalFilters.length > 0 ? [{ filters: additionalFilters }] : [];
  }

  if (accessLevel === 'team') {
    const teamIds = identity.hubspotTeams.map(t => t.id || t);
    if (teamIds.length > 0) {
      return [{ filters: [{ propertyName: 'hubspot_team_id', operator: 'IN', values: teamIds }, ...additionalFilters] }];
    }
  }

  if (!identity.ownerId) {
    return additionalFilters.length > 0 ? [{ filters: additionalFilters }] : [];
  }

  const primaryField = POSITION_PRIMARY_OWNER_FIELD[identity.position] || null;
  const portalFields = (portalId && MULTI_OWNER_FIELDS_BY_PORTAL[String(portalId)]) || MULTI_OWNER_FIELDS;
  const ownerFields = portalFields[objectType] || ['hubspot_owner_id'];

  const orderedFields = primaryField && ownerFields.includes(primaryField)
    ? [primaryField, ...ownerFields.filter(f => f !== primaryField)]
    : ownerFields;

  if (orderedFields.length === 1) {
    return [{ filters: [{ propertyName: orderedFields[0], operator: 'EQ', value: identity.ownerId }, ...additionalFilters] }];
  }

  return orderedFields.map(field => ({
    filters: [{ propertyName: field, operator: 'EQ', value: identity.ownerId }, ...additionalFilters],
  }));
}

// --- Routes ---

app.get('/health', (req, res) => {
  let routingTableSize = 0;
  try { const rt = loadRoutingTable(); routingTableSize = Object.keys(rt.userDirectory || {}).length; } catch {}
  res.json({ status: 'ok', uptime: process.uptime(), routingTableSize, cacheSize: identityCache.size });
});

app.get('/identity/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const portalId = req.query.portal_id;
    if (!portalId) return res.status(400).json({ error: 'portal_id query param required' });
    const identity = await resolveIdentity(email, portalId);
    const { token, ...safe } = identity;
    res.json(safe);
  } catch (err) {
    console.error('Identity resolution failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/query', async (req, res) => {
  try {
    const { email, portal_id, object, filters, properties, limit, countOnly, dateFilter, department } = req.body;
    if (!email || !portal_id || !object) return res.status(400).json({ error: 'email, portal_id, and object are required' });

    const identity = await resolveIdentity(email, portal_id);

    const allowedObjects = identity.allowedObjects || [];
    const objectSimple = object.replace('crm.objects.', '').replace('.read', '');
    const customObjectPattern = /^\d+-\d+$/;
    const isCustomObject = customObjectPattern.test(object);
    if (allowedObjects.length > 0 && !isCustomObject) {
      const objectCategory = ['contacts','companies','deals'].includes(objectSimple) ? objectSimple : 'custom';
      if (!allowedObjects.includes(objectCategory) && !allowedObjects.includes(objectSimple)) {
        return res.status(403).json({ error: `Object type '${object}' not allowed for your role (${identity.positionGroup})`, code: 'OBJECT_ACCESS_DENIED' });
      }
    }
    if (isCustomObject && allowedObjects.length > 0 && !allowedObjects.includes('custom')) {
      return res.status(403).json({ error: `Custom object access not allowed for your role (${identity.positionGroup})`, code: 'OBJECT_ACCESS_DENIED' });
    }

    const effectiveLevel = identity.accessLevel;
    const baseFilters = Array.isArray(filters) ? filters : [];
    const extraFilters = [...baseFilters];

    const ytdStart = new Date(new Date().getFullYear(), 0, 1).getTime();
    const appliedDateFilter = dateFilter !== undefined ? dateFilter : {
      field: DEFAULT_DATE_FIELD[object] || 'hs_createdate',
      start: ytdStart,
    };

    if (appliedDateFilter && typeof appliedDateFilter === 'object') {
      if (appliedDateFilter.start && appliedDateFilter.end) {
        extraFilters.push({ propertyName: appliedDateFilter.field, operator: 'BETWEEN', value: String(appliedDateFilter.start), highValue: String(appliedDateFilter.end) });
      } else if (appliedDateFilter.start) {
        extraFilters.push({ propertyName: appliedDateFilter.field, operator: 'GTE', value: String(appliedDateFilter.start) });
      } else if (appliedDateFilter.end) {
        extraFilters.push({ propertyName: appliedDateFilter.field, operator: 'LTE', value: String(appliedDateFilter.end) });
      }
    }

    if (department) extraFilters.push({ propertyName: 'department', operator: 'EQ', value: department });

    const filterGroups = buildOwnershipFilterGroups(identity, object, extraFilters, portal_id);

    const searchBody = {
      filterGroups,
      properties: countOnly ? [] : (properties || []),
      limit: countOnly ? 0 : (limit || 100),
    };

    const apiToken = ADMIN_TOKENS[String(portal_id)] || identity.token;
    const hsResp = await axios.post(`${HUBSPOT_API}/crm/v3/objects/${object}/search`, searchBody, { headers: { Authorization: `Bearer ${apiToken}` } });

    const total = hsResp.data.total ?? 0;
    const results = countOnly ? [] : (hsResp.data.results || []);
    const filtersApplied = filterGroups.flatMap(fg => fg.filters);

    auditLog({ email, accessLevel: effectiveLevel, portal: portal_id, object, countOnly: !!countOnly, filtersApplied, resultCount: total });

    res.json({
      caller: { email: identity.email, positionGroup: identity.positionGroup, accessLevel: effectiveLevel, ownerId: identity.ownerId, canWrite: identity.canWrite },
      filtersApplied, total,
      ...(countOnly ? {} : { results }),
    });
  } catch (err) {
    console.error('Query failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/reports', (req, res) => {
  const registry = loadReportRegistry();
  res.json({ reports: Object.entries(registry).map(([id, def]) => ({ id, portal: def.portal, object: def.object, accessRequired: def.accessRequired })) });
});

app.get('/reports/:reportId', (req, res) => {
  const registry = loadReportRegistry();
  const report = registry[req.params.reportId];
  if (!report) return res.status(404).json({ error: 'Report not found' });
  res.json({ id: req.params.reportId, ...report });
});

app.post('/reports/:reportId', async (req, res) => {
  try {
    const { reportId } = req.params;
    const { email, portal_id } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const registry = loadReportRegistry();
    const report = registry[reportId];
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const portalId = portal_id || report.portal;
    const identity = await resolveIdentity(email, portalId);
    if (!identity.proxyEnabled) return res.status(403).json({ error: 'Proxy not enabled for this user' });

    const token = ADMIN_TOKENS[String(portal_id)] || identity.token;
    const lockedFilters = [];
    for (const [prop, values] of Object.entries(report.lockedFilters || {})) {
      lockedFilters.push({ propertyName: prop, operator: 'IN', values });
    }

    const accessReg = loadAccessRegistry();
    const override = accessReg[email]?.accessOverride;
    if (override) identity.accessOverride = override;
    const effectiveLevel = identity.accessOverride || identity.accessLevel;

    let reportOwnerField = null;
    if (report.ownerFields && identity.position) {
      for (const [field, positions] of Object.entries(report.ownerFields)) {
        if (positions.includes(identity.position)) { reportOwnerField = field; break; }
      }
    }

    let filterGroups;
    if (effectiveLevel === 'org') {
      filterGroups = lockedFilters.length > 0 ? [{ filters: lockedFilters }] : [];
    } else if (reportOwnerField && identity.ownerId) {
      filterGroups = [{ filters: [{ propertyName: reportOwnerField, operator: 'EQ', value: identity.ownerId }, ...lockedFilters] }];
    } else {
      filterGroups = buildOwnershipFilterGroups(identity, report.object, lockedFilters);
    }

    const countOnly = req.body.countOnly === true;
    const searchBody = { filterGroups, properties: countOnly ? [] : (report.requiredProperties || []), limit: countOnly ? 0 : (req.body.limit || 100) };
    const hsResp = await axios.post(`${HUBSPOT_API}/crm/v3/objects/${report.object}/search`, searchBody, { headers: { Authorization: `Bearer ${token}` } });

    const total = hsResp.data.total ?? 0;
    const results = countOnly ? [] : (hsResp.data.results || []);
    const filtersApplied = filterGroups.flatMap(fg => fg.filters);

    auditLog({ email, accessLevel: effectiveLevel, portal: portalId, object: report.object, report: reportId, countOnly, filtersApplied, resultCount: total });

    res.json({
      caller: { email: identity.email, position: identity.position, accessLevel: effectiveLevel, ownerId: identity.ownerId, ownerFieldUsed: reportOwnerField || 'multi-owner' },
      report: reportId, filtersApplied, total,
      ...(countOnly ? {} : { results }),
    });
  } catch (err) {
    console.error('Report execution failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/write', async (req, res) => {
  try {
    const { email, portal_id, object, record_id, properties } = req.body;
    if (!email || !portal_id || !object || !properties) {
      return res.status(400).json({ error: 'email, portal_id, object, and properties are required' });
    }

    const identity = await resolveIdentity(email, portal_id);
    if (!identity.canWrite) {
      return res.status(403).json({ error: `Write access denied for your role (${identity.positionGroup})`, code: 'WRITE_ACCESS_DENIED' });
    }

    const { raw = false } = req.body;
    const writeProperties = { ...properties };
    if (!raw && identity.ownerId) writeProperties.hubspot_owner_id = identity.ownerId;

    const apiToken = ADMIN_TOKENS[String(portal_id)] || identity.token;

    if (identity.writeScope === 'owned' && record_id) {
      try {
        const existing = await axios.get(`${HUBSPOT_API}/crm/v3/objects/${object}/${record_id}`, {
          params: { properties: 'hubspot_owner_id' },
          headers: { Authorization: `Bearer ${apiToken}` }
        });
        const currentOwner = existing.data.properties?.hubspot_owner_id;
        if (currentOwner && currentOwner !== identity.ownerId) {
          return res.status(403).json({ error: `Write denied — record is owned by another user`, code: 'WRITE_OWNERSHIP_VIOLATION', recordOwner: currentOwner, requestingUser: identity.ownerId });
        }
      } catch (err) {
        if (err.response?.status !== 404) console.error(`Ownership check failed for ${object}/${record_id}:`, err.message);
      }
    }

    let result;
    const NON_STANDARD_PATHS = { 'lists': `${HUBSPOT_API}/crm/v3/lists` };
    const apiPath = NON_STANDARD_PATHS[object] || null;

    if (apiPath) {
      const body = object === 'lists' ? properties : (raw ? properties : writeProperties);
      const method = record_id ? 'patch' : 'post';
      const url = record_id ? `${apiPath}/${record_id}` : apiPath;
      if (object === 'lists') console.log(`[LIST DEBUG] Body being sent to HubSpot:`, JSON.stringify(body, null, 2));
      const resp = await axios[method](url, body, { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } });
      result = resp.data;
    } else if (record_id) {
      const resp = await axios.patch(`${HUBSPOT_API}/crm/v3/objects/${object}/${record_id}`, { properties: writeProperties }, { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } });
      result = resp.data;
    } else {
      const resp = await axios.post(`${HUBSPOT_API}/crm/v3/objects/${object}`, { properties: writeProperties }, { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } });
      result = resp.data;
    }

    auditLog({ email, accessLevel: identity.accessLevel, portal: portal_id, object, action: record_id ? 'update' : 'create', record_id: record_id || result.id, ownerStamped: identity.ownerId || null });

    res.json({
      success: true, action: record_id ? 'updated' : 'created', record_id: record_id || result.id,
      caller: { email: identity.email, positionGroup: identity.positionGroup, accessLevel: identity.accessLevel, ownerStamped: identity.ownerId, writeScope: identity.writeScope },
      result,
    });
  } catch (err) {
    console.error('Write failed:', err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// --- Dynamic List endpoint ---

const DYNAMIC_LIST_PORTAL = '21203560';
const PRIMARY_STAGES   = ['123913016','123632917','123632918','123366314','123913017','123632921'];
const SECONDARY_STAGES = ['124162840','123632915','123632923','123966819','123866264','123632920'];
const EXCLUDED_STAGES  = ['123864449','123332639','1151213622','1151213621','123632922','123632924','127957093'];
const DYNAMIC_LIST_ACCESS = ['CS_TeamLeaders','CS_DeptLeads','OrgView_Both','Dev_IT','Finance','Executive','Manager'];

async function runDynamicTierQuery(token, campaignName, stageIds, requireDynamicFlag, icpFilters = {}, limit = 200) {
  const group1 = [
    { propertyName: 'hs_pipeline_stage', operator: 'IN', values: stageIds },
    { propertyName: 'list_name', operator: 'NOT_CONTAINS_TOKEN', value: '_nda' },
    { propertyName: 'dynamic_list_target', operator: 'NOT_CONTAINS_TOKEN', value: campaignName },
  ];
  if (requireDynamicFlag) group1.push({ propertyName: 'dynamic_list_allowed', operator: 'EQ', value: 'true' });
  if (icpFilters.country?.length) {
    const countryTokens = icpFilters.country.map(c => c.toLowerCase()).join(' OR ');
    group1.push({ propertyName: 'country', operator: 'CONTAINS_TOKEN', value: countryTokens });
  }
  if (icpFilters.industry?.length) {
    const industryTokens = icpFilters.industry.map(i => i.toLowerCase()).join(' OR ');
    group1.push({ propertyName: 'industry', operator: 'CONTAINS_TOKEN', value: industryTokens });
  }

  const group2 = [{ propertyName: 'hs_pipeline_stage', operator: 'NOT_IN', values: EXCLUDED_STAGES }];
  if (icpFilters.country?.length) {
    const countryTokens = icpFilters.country.map(c => c.toLowerCase()).join(' OR ');
    group2.push({ propertyName: 'country', operator: 'CONTAINS_TOKEN', value: countryTokens });
  }
  if (icpFilters.state?.length) group2.push({ propertyName: 'state', operator: 'IN', values: icpFilters.state });
  if (icpFilters.job_title_keywords?.length) {
    group2.push({ propertyName: 'job_title', operator: 'CONTAINS_TOKEN', value: icpFilters.job_title_keywords.join(' OR ') });
  }

  const payload = {
    filterGroups: [{ filters: group1 }, { filters: group2 }],
    properties: ['email','hs_email_domain','company','hs_lastmodifieddate','list_name','dynamic_list_target','dynamic_list_allowed','hs_pipeline_stage','firstname','lastname','job_title','country','state','industry'],
    limit: Math.min(limit, 200),
  };

  const resp = await axios.post(`${HUBSPOT_API}/crm/v3/objects/2-20106951/search`, payload, { headers: { Authorization: `Bearer ${token}` } });
  return resp.data;
}

function deduplicateRecords(records) {
  const byEmail = new Map();
  const byCompany = new Map();
  for (const r of records) {
    const email = r.properties?.email?.toLowerCase();
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, r);
  }
  for (const r of byEmail.values()) {
    const domain = r.properties?.hs_email_domain || r.properties?.company || r.id;
    const existing = byCompany.get(domain);
    if (!existing) {
      byCompany.set(domain, r);
    } else {
      const newDate = new Date(r.properties?.hs_lastmodifieddate || 0);
      const existDate = new Date(existing.properties?.hs_lastmodifieddate || 0);
      if (newDate > existDate) byCompany.set(domain, r);
    }
  }
  return Array.from(byCompany.values());
}

app.post('/query/dynamic-list', async (req, res) => {
  try {
    const { email, portal_id, campaign_name, icp_filters = {}, countOnly = false } = req.body;

    if (!email || !campaign_name) return res.status(400).json({ error: 'email and campaign_name are required' });
    if (!icp_filters.country?.length && !icp_filters.industry?.length && !icp_filters.job_title_keywords?.length) {
      return res.status(400).json({ error: 'ICP filters required — provide at least country, industry, or job_title_keywords' });
    }

    const portalId = DYNAMIC_LIST_PORTAL;
    const identity = await resolveIdentity(email, portalId);

    if (!DYNAMIC_LIST_ACCESS.includes(identity.positionGroup)) {
      return res.status(403).json({ error: `Dynamic list access denied for your role (${identity.positionGroup})`, code: 'DYNAMIC_LIST_ACCESS_DENIED' });
    }

    const apiToken = ADMIN_TOKENS[portalId] || identity.token;

    const t1 = await runDynamicTierQuery(apiToken, campaign_name, PRIMARY_STAGES, true, icp_filters, 200);
    const t2 = await runDynamicTierQuery(apiToken, campaign_name, SECONDARY_STAGES, true, icp_filters, 200);
    const combinedRaw = [...(t1.results||[]), ...(t2.results||[])];
    let combined = deduplicateRecords(combinedRaw);

    let tier3Used = false, t3Total = 0;
    if (combined.length < 100) {
      const t3 = await runDynamicTierQuery(apiToken, campaign_name, [...PRIMARY_STAGES, ...SECONDARY_STAGES], false, icp_filters, 200);
      t3Total = t3.total || 0;
      combined = deduplicateRecords([...combinedRaw, ...(t3.results||[])]);
      tier3Used = true;
    }

    const total = combined.length;
    if (countOnly) {
      return res.json({ total, tier1: t1.total || 0, tier2: t2.total || 0, tier3: tier3Used ? t3Total : null, tier3_used: tier3Used, after_dedup: total });
    }
    if (total > 500) {
      return res.json({ status: 'too_many', message: `Found ${total} records after deduplication — too broad.`, total, tier1: t1.total || 0, tier2: t2.total || 0, tier3_used: tier3Used, suggestion: 'Try narrowing by country, job title, or industry' });
    }

    const finalRecords = combined.slice(0, 500);
    const today = new Date().toISOString().slice(0, 10);
    const listName = `${campaign_name} - Dynamic Pull - ${today}`;

    const listResp = await axios.post(`${HUBSPOT_API}/crm/v3/lists`, { name: listName, objectTypeId: '2-20106951', processingType: 'MANUAL' }, { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } });
    const listId = listResp.data?.list?.listId;

    if (listId && finalRecords.length) {
      const recordIds = finalRecords.map(r => r.id);
      for (let i = 0; i < recordIds.length; i += 100) {
        const batch = recordIds.slice(i, i + 100);
        await axios.put(`${HUBSPOT_API}/crm/v3/lists/${listId}/memberships/add`, batch, { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } })
          .catch(err => console.error(`[dynamic-list] Failed to add batch ${i}:`, err.message));
      }
    }

    const appendValue = `${campaign_name} (${today})`;
    await Promise.allSettled(finalRecords.map(async (r) => {
      const current = r.properties?.dynamic_list_target || '';
      if (current.length + appendValue.length + 2 > 10000) return;
      const newValue = current ? `${current}, ${appendValue}` : appendValue;
      await axios.patch(`${HUBSPOT_API}/crm/v3/objects/2-20106951/${r.id}`, { properties: { dynamic_list_target: newValue } }, { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } })
        .catch(err => console.error(`[dynamic-list] Failed to update record ${r.id}:`, err.message));
    }));

    auditLog({ email, accessLevel: identity.accessLevel, portal: portalId, object: '2-20106951', action: 'dynamic-list', campaign_name, resultCount: finalRecords.length });

    res.json({
      success: true, campaign_name, list_name: listName, list_id: listId,
      list_url: `https://app.hubapi.com/contacts/${portalId}/objectLists/${listId}`,
      caller: { email: identity.email, positionGroup: identity.positionGroup },
      summary: { total_pulled: finalRecords.length, tier1_count: Math.min(t1.results?.length || 0, finalRecords.length), tier2_count: Math.min(t2.results?.length || 0, finalRecords.length), tier3_used: tier3Used },
    });
  } catch (err) {
    console.error('Dynamic list failed:', err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`hubspot-proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`Routing table: ${ROUTING_TABLE_PATH}`);
  console.log(`Admin tokens loaded: MarketingCRM=${!!ADMIN_TOKENS['4950628']}, OneCRM=${!!ADMIN_TOKENS['21203560']}`);
});
