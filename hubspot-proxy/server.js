import express from 'express';
import axios from 'axios';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import pg from 'pg';
const { Pool } = pg;

const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev',
});

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

// --- Role-based helpers for DB users ---

function resolvePositionGroupFromRoles(roles, position) {
  if (roles.includes('system_developer') || roles.includes('it_admin')) return 'Dev_IT';
  if (roles.includes('quality_analyst') || roles.includes('qa_user') || roles.includes('marketing qa') || roles.includes('memo_qa_access')) return 'QA';
  if (roles.includes('bdr') || roles.includes('business_development_representative')) return 'BDR';
  if (roles.includes('finance')) return 'Finance';
  if (roles.includes('executive') || roles.includes('exec')) return 'Executive';
  if (roles.includes('manager')) return 'Manager';
  // fallback: match by position string
  try {
    const rt = loadRoutingTable();
    const group = resolvePositionGroup(null, position, rt);
    if (group) return group._groupName;
  } catch {}
  return 'standard';
}

function resolveAllowedObjectsFromRoles(roles, accessLevel) {
  if (roles.includes('system_developer') || roles.includes('it_admin')) return ['contacts', 'companies', 'deals', 'owners', '2-20106951'];
  if (roles.includes('quality_analyst') || roles.includes('qa_user') || roles.includes('marketing qa') || roles.includes('memo_qa_access')) return ['contacts', 'companies', 'deals'];
  if (roles.includes('bdr') || roles.includes('business_development_representative')) return ['contacts', 'companies', 'deals'];
  return ['contacts', 'companies', 'deals'];
}

function resolveCanWriteFromRoles(roles, accessLevel) {
  if (roles.includes('system_developer') || roles.includes('it_admin') || roles.includes('finance') || roles.includes('executive')) return true;
  if (roles.includes('quality_analyst') || roles.includes('qa_user') || roles.includes('marketing qa') || roles.includes('memo_qa_access')) return false;
  if (roles.includes('bdr') || roles.includes('business_development_representative')) return false;
  return accessLevel === 'org' || accessLevel === 'admin';
}

function resolveWriteScopeFromRoles(roles, accessLevel) {
  if (roles.includes('system_developer') || roles.includes('it_admin') || roles.includes('finance') || roles.includes('executive')) return 'any';
  return 'owned';
}

// --- DB identity lookup (user_integrations) ---

async function resolveIdentityFromDB(email, portalId) {
  const pid = String(portalId);
  const result = await dbPool.query(
    `SELECT ui.meta, ui.credentials, ui.access_level, ui.enabled, ui.scopes,
            a.email as account_email
     FROM fleet.user_integrations ui
     JOIN fleet.accounts a ON a.id = ui.account_id
     WHERE a.email = $1 AND ui.integration = 'hubspot' AND ui.portal_id = $2 AND ui.enabled = true
     LIMIT 1`,
    [email, pid]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    email,
    name: row.meta?.name || email,
    position: row.meta?.position || null,
    department: row.meta?.department || null,
    positionGroup: resolvePositionGroupFromRoles(row.meta?.roles || [], row.meta?.position),
    accessLevel: row.access_level || 'standard',
    allowedPortals: [pid],
    allowedObjects: resolveAllowedObjectsFromRoles(row.meta?.roles || [], row.access_level),
    topics: [],
    canWrite: resolveCanWriteFromRoles(row.meta?.roles || [], row.access_level),
    writeScope: resolveWriteScopeFromRoles(row.meta?.roles || [], row.access_level),
    database: true,
    ownerId: row.meta?.owner_id || null,
    hubspotTeams: [],
    primaryTeam: null,
    proxyEnabled: true,
    token: null, // resolved separately via getToken
    _source: 'db',
  };
}

// --- Full identity resolution ---

async function resolveIdentity(email, portalId) {
  const cached = getCached(email, portalId);
  if (cached) return cached;

  // Priority 1: fleet.user_integrations DB
  let user = null;
  let identity = null;
  try {
    identity = await resolveIdentityFromDB(email, portalId);
    if (identity) {
      console.log(`[identity] Resolved ${email} from DB (user_integrations)`);
    }
  } catch (err) {
    console.error(`[identity] DB lookup failed for ${email}:`, err.message);
  }

  // Priority 2: routing-table.json fallback
  if (!identity) {
    const rt = loadRoutingTable();
    const userDir = rt.userDirectory || {};
    user = userDir[email];
    if (!user) throw new Error(`User not found in routing table or DB: ${email}`);

    const group = resolvePositionGroup(email, user.position, rt);
    if (!group) throw new Error(`No position group found for ${email} (position: ${user.position}). Access denied.`);

    const allowedPortals = group.portal || [];
    if (allowedPortals.length > 0 && !allowedPortals.includes(String(portalId))) {
      throw new Error(`Portal ${portalId} not authorized for ${email} (group: ${group._groupName}, allowed: ${allowedPortals.join(', ')})`);
    }

    const accessLevel = group.accessLevel || 'owner';
    const canWrite = ['Dev_IT', 'Finance', 'Executive', 'CS_DeptLeads', 'Marketing_GroupLeaders',
      'Sales_GroupLeaders', 'CS_TeamLeaders', 'Sales_Group', 'Marketing_Group'].includes(group._groupName);
    const writeScope = ['Dev_IT', 'Finance', 'Executive'].includes(group._groupName) ? 'any' : 'owned';

    identity = {
      email, name: user.name, position: user.position, department: user.department,
      branch: user.branch, agent: user.agent, positionGroup: group._groupName,
      accessLevel, allowedPortals, allowedObjects: group.objects || [], topics: group.topics || [],
      canWrite, writeScope, database: group.database || false,
      ownerId: user.ownerId || null, hubspotTeams: user.hubspotTeams || [], primaryTeam: user.primaryTeam || null,
      proxyEnabled: true, token: null,
      _source: 'routing-table',
    };
    console.log(`[identity] Resolved ${email} from routing-table.json (fallback)`);
  }

  // Resolve token (always)
  try {
    identity.token = await getToken(email, portalId);
  } catch (err) {
    console.error(`[identity] Token fetch failed for ${email}:`, err.message);
  }

  // Resolve ownerId if missing
  if (!identity.ownerId && identity.token) {
    try {
      const ownerInfo = await resolveOwner(email, identity.token);
      if (ownerInfo) {
        identity.ownerId = ownerInfo.ownerId;
        identity.hubspotTeams = ownerInfo.teams;
        identity.primaryTeam = ownerInfo.primaryTeam;
      }
    } catch (err) {
      console.error(`[identity] Owner resolution failed for ${email}:`, err.message);
    }
  }

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

  if (accessLevel === 'org' || accessLevel === 'admin') {
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
    const { email, portal_id, object, filters, properties, limit, countOnly, dateFilter, department, record_id, withAssociations } = req.body;
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

    // Date filter logic:
    // - Specific record lookup (record_id passed, or filters contain an ID match) → no date filter
    // - Explicit dateFilter passed → use it
    // - Broad/group query → default to last 3 years
    const isSpecificLookup = !!record_id ||
      (Array.isArray(filters) && filters.some(f => f.propertyName === 'hs_object_id' && (f.operator === 'EQ' || f.operator === 'IN')));
    const threeYearsAgo = new Date();
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
    const defaultDateFilter = isSpecificLookup ? null : {
      field: DEFAULT_DATE_FIELD[object] || 'hs_createdate',
      start: threeYearsAgo.getTime(),
    };
    const appliedDateFilter = dateFilter !== undefined ? dateFilter : defaultDateFilter;

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
    let results = countOnly ? [] : (hsResp.data.results || []);
    const filtersApplied = filterGroups.flatMap(fg => fg.filters);

    // Auto-enrich deals with associated contacts when withAssociations=true or object is deals
    const shouldEnrich = !countOnly && (withAssociations === true || (withAssociations !== false && object === 'deals'));
    if (shouldEnrich && results.length > 0) {
      try {
        const CONTACT_PROPS = ['email','firstname','lastname','phone','jobtitle','company','lifecyclestage','hs_lead_status'];
        const dealIds = results.map(r => r.id);

        // Step 1: batch read deals with associations to get contact IDs inline
        const dealBatchResp = await axios.post(
          `${HUBSPOT_API}/crm/v3/objects/deals/batch/read`,
          { inputs: dealIds.map(id => ({ id })), properties: [], associations: ['contacts'] },
          { headers: { Authorization: `Bearer ${apiToken}` } }
        ).catch(() => null);

        if (dealBatchResp?.data?.results?.length) {
          // Build map: dealId -> [contactIds]
          const dealContactMap = {};
          for (const deal of dealBatchResp.data.results) {
            const contactAssocs = deal.associations?.contacts?.results || [];
            dealContactMap[deal.id] = contactAssocs.map(a => a.id);
          }

          // Step 2: collect all unique contact IDs and batch read
          const allContactIds = [...new Set(Object.values(dealContactMap).flat())];
          if (allContactIds.length > 0) {
            const contactResp = await axios.post(
              `${HUBSPOT_API}/crm/v3/objects/contacts/batch/read`,
              { inputs: allContactIds.map(id => ({ id })), properties: CONTACT_PROPS },
              { headers: { Authorization: `Bearer ${apiToken}` } }
            ).catch(() => null);

            if (contactResp?.data?.results?.length) {
              const contactMap = {};
              for (const c of contactResp.data.results) contactMap[c.id] = c;
              results = results.map(deal => ({
                ...deal,
                associated_contacts: (dealContactMap[deal.id] || []).map(cid => contactMap[cid]).filter(Boolean)
              }));
            }
          }
        }
      } catch (enrichErr) {
        console.error('[query] Association enrichment failed:', enrichErr.message);
        // Non-fatal — return results without enrichment
      }
    }

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
    const { email, portal_id, campaign_name, icp_filters = {}, countOnly = false, dry_run = false, mode = 'fresh', deal_id = null } = req.body;
    // mode: 'fresh' (default) = static list creation | 'live' = convert ICP to HubSpot active list + update deal properties

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

    // countOnly — return counts only, no records
    if (countOnly) {
      return res.json({ total, tier1: t1.total || 0, tier2: t2.total || 0, tier3: tier3Used ? t3Total : null, tier3_used: tier3Used, after_dedup: total });
    }

    if (total > 500) {
      return res.json({ status: 'too_many', message: `Found ${total} records after deduplication — too broad.`, total, tier1: t1.total || 0, tier2: t2.total || 0, tier3_used: tier3Used, suggestion: 'Try narrowing by country, job title, or industry' });
    }

    const finalRecords = combined.slice(0, 500);
    const today = new Date().toISOString().slice(0, 10);
    const listName = `${campaign_name} - Dynamic Pull - ${today}`;

    // dry_run — return preview without creating list or stamping records
    if (dry_run) {
      auditLog({ email, accessLevel: identity.accessLevel, portal: portalId, object: '2-20106951', action: 'dynamic-list-dry-run', campaign_name, resultCount: finalRecords.length });
      return res.json({
        dry_run: true,
        campaign_name,
        list_name: listName,
        caller: { email: identity.email, positionGroup: identity.positionGroup },
        summary: {
          total_pulled: finalRecords.length,
          tier1_count: Math.min(t1.results?.length || 0, finalRecords.length),
          tier2_count: Math.min(t2.results?.length || 0, finalRecords.length),
          tier3_used: tier3Used,
        },
        records: finalRecords.map(r => ({
          id: r.id,
          email: r.properties?.email,
          firstname: r.properties?.firstname,
          lastname: r.properties?.lastname,
          company: r.properties?.company,
          job_title: r.properties?.job_title,
          country: r.properties?.country,
          industry: r.properties?.industry,
          pipeline_stage: r.properties?.hs_pipeline_stage,
          dynamic_list_target: r.properties?.dynamic_list_target,
        })),
      });
    }

    // ── LIVE MODE: HubSpot Active List + update deal properties ──
    if (mode === 'live') {
      // Step 1: Find deal by campaign_name
      let resolvedDealId = deal_id;
      if (!resolvedDealId) {
        const dealSearch = await axios.post(`${HUBSPOT_API}/crm/v3/objects/deals/search`, {
          filterGroups: [{ filters: [{ propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: campaign_name }] }],
          properties: ['dealname', 'hs_object_id'], limit: 10
        }, { headers: { Authorization: `Bearer ${apiToken}` } }).catch(() => null);
        const dealResults = dealSearch?.data?.results || [];
        if (dealResults.length === 0)
          return res.status(400).json({ error: `No deals found matching "${campaign_name}". Please provide a deal_id or deal link.`, code: 'DEAL_NOT_FOUND' });
        if (dealResults.length > 1)
          return res.status(400).json({ error: `Multiple deals (${dealResults.length}) match "${campaign_name}". Which one?`, code: 'DEAL_AMBIGUOUS', deals: dealResults.map(d => ({ id: d.id, name: d.properties?.dealname })) });
        resolvedDealId = dealResults[0].id;
      }

      // Step 2: Convert ICP to HubSpot filter format
      const icpFiltersArr = [];
      if (icp_filters.country?.length) icpFiltersArr.push({ propertyName: 'country', operator: 'IN', values: icp_filters.country });
      if (icp_filters.state?.length) icpFiltersArr.push({ propertyName: 'state', operator: 'IN', values: icp_filters.state });
      if (icp_filters.industry?.length) icpFiltersArr.push({ propertyName: 'industry', operator: 'IN', values: icp_filters.industry });
      if (icp_filters.job_title_keywords?.length) icpFiltersArr.push({ propertyName: 'job_title', operator: 'CONTAINS_TOKEN', value: icp_filters.job_title_keywords.join(' OR ') });
      const icpJson = JSON.stringify({ filterGroups: [{ filters: icpFiltersArr }] });

      // Step 3: Create HubSpot Active (DYNAMIC) list
      const liveListName = `CS Dynamic List - ${campaign_name}`;
      const listResp = await axios.post(`${HUBSPOT_API}/crm/v3/lists`, {
        name: liveListName, objectTypeId: '2-20106951', processingType: 'DYNAMIC',
        filterBranch: {
          filterBranchType: 'AND',
          filters: icpFiltersArr.map(f => ({
            filterType: 'PROPERTY', property: f.propertyName,
            operation: { operationType: 'MULTISTRING', includeObjectsWithNoValueSet: false, values: f.values || [f.value] }
          })),
          filterBranches: []
        }
      }, { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } }).catch(e => ({ data: e.response?.data }));
      const listId = listResp?.data?.list?.listId || listResp?.data?.listId || null;

      // Step 4: Update deal with ICP + enrolment property
      await axios.patch(`${HUBSPOT_API}/crm/v3/objects/deals/${resolvedDealId}`, {
        properties: {
          dynamic_list_icp: icpJson,
          dynamic_list_enrolment: `CS Dynamic List - ${campaign_name}`
        }
      }, { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } })
        .catch(err => console.error('[dynamic-list/live] Deal update failed:', err.message));

      auditLog({ email, accessLevel: identity.accessLevel, portal: portalId, object: '2-20106951', action: 'dynamic-list-live', campaign_name, resultCount: finalRecords.length });

      return res.json({
        success: true, mode: 'live', campaign_name,
        list_name: liveListName, list_id: listId,
        list_url: listId ? `https://app.hubapi.com/contacts/${portalId}/objectLists/${listId}` : null,
        deal_id: resolvedDealId, icp_applied: icpFiltersArr,
        caller: { email: identity.email, positionGroup: identity.positionGroup },
        summary: { total_matched: finalRecords.length, tier1_count: Math.min(t1.results?.length || 0, finalRecords.length), tier2_count: Math.min(t2.results?.length || 0, finalRecords.length), tier3_used: tier3Used },
      });
    }

    // ── FRESH MODE (default): static list + stamp records ──
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

// --- Lead Qualification (FAINT) — MarketingCRM only ---

const QUALIFY_PORTAL = '4950628'; // MarketingCRM

// HubSpot object type IDs
const HS_OBJECT_TYPE_MAP = {
  '0-1': 'contact',
  '0-2': 'company',
  '0-3': 'deal',
};

function parseHubSpotUrl(url) {
  if (!url) return null;
  // Format 1: app.hubspot.com/contacts/<portal>/contact|deal|company/<id>
  const m1 = url.match(/app(?:-[a-z0-9]+)?\.hubspot\.com\/contacts\/(\d+)\/(contact|deal|company)\/(\d+)/);
  if (m1) return { portal_id: m1[1], type: m1[2], id: m1[3] };
  // Format 2: app-na2.hubspot.com/contacts/<portal>/record/<typeId>/<id>
  const m2 = url.match(/app(?:-[a-z0-9]+)?\.hubspot\.com\/contacts\/(\d+)\/record\/([0-9-]+)\/(\d+)/);
  if (m2) {
    const type = HS_OBJECT_TYPE_MAP[m2[2]] || null;
    if (!type) return null;
    return { portal_id: m2[1], type, id: m2[3] };
  }
  return null;
}

app.post('/qualify', async (req, res) => {
  try {
    let { email, contact_id, deal_id, url } = req.body;

    // Parse from HubSpot URL if provided
    if (url) {
      const parsed = parseHubSpotUrl(url);
      if (!parsed) return res.status(400).json({ error: 'Could not parse HubSpot URL. Expected format: https://app.hubspot.com/contacts/<portal>/contact/<id>' });
      if (parsed.type === 'contact') contact_id = parsed.id;
      else if (parsed.type === 'deal') deal_id = parsed.id;
      else return res.status(400).json({ error: `Unsupported object type in URL: ${parsed.type}` });
    }
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (!contact_id && !deal_id) return res.status(400).json({ error: 'contact_id or deal_id is required' });

    const identity = await resolveIdentity(email, QUALIFY_PORTAL);
    const apiToken = ADMIN_TOKENS[QUALIFY_PORTAL] || identity.token;
    if (!apiToken) return res.status(403).json({ error: 'No API token available for MarketingCRM' });

    const headers = { Authorization: `Bearer ${apiToken}` };

    // Fetch contact properties
    const contactProps = [
      'email','firstname','lastname','company','jobtitle','phone',
      'country','state','industry','hs_lead_status','lifecyclestage',
      'num_contacted_notes','notes_last_contacted','hs_email_last_open_date',
      'hs_email_last_click_date','hs_last_sales_activity_date',
      'hs_analytics_num_visits','hs_analytics_num_page_views',
      'createdate','lastmodifieddate','hs_pipeline_stage'
    ];

    let contact = null;
    let deals = [];
    let activities = [];

    if (contact_id) {
      const cResp = await axios.get(
        `${HUBSPOT_API}/crm/v3/objects/contacts/${contact_id}`,
        { headers, params: { properties: contactProps.join(','), associations: 'deals' } }
      );
      contact = cResp.data;
    }

    if (deal_id) {
      const dResp = await axios.get(
        `${HUBSPOT_API}/crm/v3/objects/deals/${deal_id}`,
        { headers, params: { properties: 'dealname,dealstage,amount,closedate,pipeline,hs_deal_stage_probability,description,hs_priority,createdate,notes_last_contacted,hs_last_sales_activity_date' } }
      );
      deals = [dResp.data];

      // If no contact_id, try to get associated contact
      if (!contact) {
        try {
          const assocResp = await axios.get(
            `${HUBSPOT_API}/crm/v4/objects/deals/${deal_id}/associations/contacts`,
            { headers }
          );
          const firstContact = assocResp.data?.results?.[0];
          if (firstContact) {
            const cResp = await axios.get(
              `${HUBSPOT_API}/crm/v3/objects/contacts/${firstContact.toObjectId}`,
              { headers, params: { properties: contactProps.join(',') } }
            );
            contact = cResp.data;
          }
        } catch (e) { /* no contact found */ }
      }
    } else if (contact?.associations?.deals?.results?.length) {
      // Fetch deals from contact associations
      const dealIds = contact.associations.deals.results.slice(0, 3).map(d => d.id);
      const dealResps = await Promise.allSettled(dealIds.map(id =>
        axios.get(`${HUBSPOT_API}/crm/v3/objects/deals/${id}`, {
          headers,
          params: { properties: 'dealname,dealstage,amount,closedate,pipeline,hs_deal_stage_probability,description,hs_priority,createdate,notes_last_contacted,hs_last_sales_activity_date' }
        })
      ));
      deals = dealResps.filter(r => r.status === 'fulfilled').map(r => r.value.data);
    }

    // Fetch recent activities (engagements)
    if (contact?.id) {
      try {
        const engResp = await axios.get(
          `${HUBSPOT_API}/engagements/v1/engagements/associated/CONTACT/${contact.id}/paged`,
          { headers, params: { limit: 20 } }
        );
        activities = engResp.data?.results || [];
      } catch (e) { /* activities optional */ }
    }

    const cp = contact?.properties || {};
    const dp = deals[0]?.properties || {};
    const now = Date.now();

    // --- FAINT Scoring ---
    let scores = { fit: 0, interest: 0, authority: 0, need: 0, timeline: 0, competitor: 0 };
    let reasoning = {};

    // FIT (30pts max) — company/industry/role match
    let fitScore = 0;
    const fitNotes = [];
    if (cp.industry) { fitScore += 8; fitNotes.push(`Industry: ${cp.industry}`); }
    if (cp.jobtitle) {
      const title = (cp.jobtitle || '').toLowerCase();
      if (/director|vp|vice president|head|chief|cxo|ceo|coo|cfo|cto|ciso|svp|evp/.test(title)) { fitScore += 12; fitNotes.push(`Senior title: ${cp.jobtitle}`); }
      else if (/manager|lead|senior|principal/.test(title)) { fitScore += 8; fitNotes.push(`Mid-level title: ${cp.jobtitle}`); }
      else { fitScore += 4; fitNotes.push(`Title: ${cp.jobtitle}`); }
    }
    if (cp.company) { fitScore += 5; fitNotes.push(`Company: ${cp.company}`); }
    if (cp.country === 'United States') { fitScore += 5; fitNotes.push('US-based'); }
    scores.fit = Math.min(fitScore, 30);
    reasoning.fit = fitNotes;

    // INTEREST (20pts max) — engagement signals
    let interestScore = 0;
    const interestNotes = [];
    const lastOpen = cp.hs_email_last_open_date ? new Date(cp.hs_email_last_open_date) : null;
    const lastClick = cp.hs_email_last_click_date ? new Date(cp.hs_email_last_click_date) : null;
    const lastActivity = cp.hs_last_sales_activity_date ? new Date(cp.hs_last_sales_activity_date) : null;
    const pageViews = parseInt(cp.hs_analytics_num_page_views) || 0;
    const visits = parseInt(cp.hs_analytics_num_visits) || 0;
    if (lastClick) { interestScore += 8; interestNotes.push(`Last email click: ${lastClick.toISOString().slice(0,10)}`); }
    else if (lastOpen) { interestScore += 4; interestNotes.push(`Last email open: ${lastOpen.toISOString().slice(0,10)}`); }
    if (pageViews >= 5) { interestScore += 5; interestNotes.push(`${pageViews} page views`); }
    else if (pageViews > 0) { interestScore += 2; interestNotes.push(`${pageViews} page views`); }
    if (visits >= 3) { interestScore += 4; interestNotes.push(`${visits} site visits`); }
    if (activities.length >= 3) { interestScore += 3; interestNotes.push(`${activities.length} logged activities`); }
    scores.interest = Math.min(interestScore, 20);
    reasoning.interest = interestNotes;

    // AUTHORITY (15pts max) — decision-making level
    let authScore = 0;
    const authNotes = [];
    const titleLow = (cp.jobtitle || '').toLowerCase();
    if (/\b(ceo|coo|cfo|cto|ciso|chief|president|owner|founder|partner)\b/.test(titleLow)) { authScore = 15; authNotes.push('C-level / Owner'); }
    else if (/\b(vp|vice president|svp|evp|director|head of)\b/.test(titleLow)) { authScore = 12; authNotes.push('VP / Director'); }
    else if (/\b(manager|lead|senior|principal)\b/.test(titleLow)) { authScore = 8; authNotes.push('Manager / Lead'); }
    else if (cp.jobtitle) { authScore = 4; authNotes.push('Individual contributor'); }
    scores.authority = authScore;
    reasoning.authority = authNotes;

    // NEED (15pts max) — pipeline stage & deal signals
    let needScore = 0;
    const needNotes = [];
    const stage = dp.dealstage || cp.hs_pipeline_stage || '';
    const lifecycle = cp.lifecyclestage || '';
    if (['closedwon','decisionmakerboughtin','contractsent','presentationscheduled'].some(s => stage.toLowerCase().includes(s))) { needScore = 15; needNotes.push(`Hot stage: ${stage}`); }
    else if (['qualifiedtobuy','appointmentscheduled'].some(s => stage.toLowerCase().includes(s))) { needScore = 10; needNotes.push(`Qualified stage: ${stage}`); }
    else if (lifecycle === 'opportunity' || lifecycle === 'salesqualifiedlead') { needScore = 8; needNotes.push(`Lifecycle: ${lifecycle}`); }
    else if (lifecycle === 'marketingqualifiedlead') { needScore = 5; needNotes.push(`Lifecycle: ${lifecycle}`); }
    else if (deals.length > 0) { needScore = 3; needNotes.push('Has open deal'); }
    scores.need = needScore;
    reasoning.need = needNotes;

    // TIMELINE (10pts max) — recency / urgency
    let timelineScore = 0;
    const timelineNotes = [];
    const lastContactedDate = dp.notes_last_contacted || cp.notes_last_contacted;
    const daysSinceContact = lastContactedDate ? Math.floor((now - new Date(lastContactedDate)) / 86400000) : null;
    const closeDate = dp.closedate ? new Date(dp.closedate) : null;
    const daysToClose = closeDate ? Math.floor((closeDate - now) / 86400000) : null;
    if (daysToClose !== null && daysToClose >= 0 && daysToClose <= 30) { timelineScore += 6; timelineNotes.push(`Close date in ${daysToClose} days`); }
    else if (daysToClose !== null && daysToClose <= 90) { timelineScore += 3; timelineNotes.push(`Close date in ${daysToClose} days`); }
    if (daysSinceContact !== null && daysSinceContact <= 7) { timelineScore += 4; timelineNotes.push(`Contacted ${daysSinceContact}d ago`); }
    else if (daysSinceContact !== null && daysSinceContact <= 30) { timelineScore += 2; timelineNotes.push(`Contacted ${daysSinceContact}d ago`); }
    else if (daysSinceContact !== null && daysSinceContact > 60) { timelineScore -= 3; timelineNotes.push(`Stalled ${daysSinceContact}d since last contact`); }
    scores.timeline = Math.max(0, Math.min(timelineScore, 10));
    reasoning.timeline = timelineNotes;

    // COMPETITOR (10pts max) — no direct signal, base on deal priority/amount
    let compScore = 5; // default neutral
    const compNotes = ['No competitor data in HubSpot — defaulting to neutral'];
    const amount = parseFloat(dp.amount) || 0;
    if (dp.hs_priority === 'high') { compScore = 8; compNotes.push('Deal priority: high'); }
    else if (dp.hs_priority === 'medium') { compScore = 6; compNotes.push('Deal priority: medium'); }
    if (amount > 50000) { compScore = Math.min(compScore + 2, 10); compNotes.push(`Deal amount: $${amount.toLocaleString()}`); }
    scores.competitor = compScore;
    reasoning.competitor = compNotes;

    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    const maxScore = 100;
    const normalizedTotal = Math.round((total / maxScore) * 100);
    let tier, action;
    if (normalizedTotal >= 80) { tier = 'Hot'; action = 'Call today'; }
    else if (normalizedTotal >= 60) { tier = 'Warm'; action = 'Call this week'; }
    else { tier = 'Nurture/Disqualify'; action = 'Add to nurture sequence or disqualify'; }

    auditLog({ email, accessLevel: identity.accessLevel, portal: QUALIFY_PORTAL, action: 'qualify', contact_id: contact?.id, deal_id: deal_id, score: normalizedTotal, tier });

    res.json({
      score: normalizedTotal,
      tier,
      action,
      contact: {
        id: contact?.id,
        name: `${cp.firstname || ''} ${cp.lastname || ''}`.trim(),
        email: cp.email,
        company: cp.company,
        title: cp.jobtitle,
        lifecycle: cp.lifecyclestage,
      },
      deal: deals[0] ? {
        id: deals[0].id,
        name: dp.dealname,
        stage: dp.dealstage,
        amount: dp.amount,
        close_date: dp.closedate,
      } : null,
      breakdown: {
        fit:        { score: scores.fit,        max: 30, weight: '30%', notes: reasoning.fit },
        interest:   { score: scores.interest,   max: 20, weight: '20%', notes: reasoning.interest },
        authority:  { score: scores.authority,  max: 15, weight: '15%', notes: reasoning.authority },
        need:       { score: scores.need,       max: 15, weight: '15%', notes: reasoning.need },
        timeline:   { score: scores.timeline,   max: 10, weight: '10%', notes: reasoning.timeline },
        competitor: { score: scores.competitor, max: 10, weight: '10%', notes: reasoning.competitor },
      },
      portal: 'MarketingCRM',
      caller: { email: identity.email, positionGroup: identity.positionGroup },
    });
  } catch (err) {
    console.error('[qualify] Error:', err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── SEMrush Routes ─────────────────────────────────────────────────────────

const SEMRUSH_API = 'https://api.semrush.com';

function parseSemrushCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(';');
  return lines.slice(1).map(line => {
    const vals = line.split(';');
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = vals[i]?.trim(); });
    return obj;
  });
}

async function getSemrushKey(email) {
  const r = await dbPool.query(
    `SELECT ui.credentials, ui.enabled FROM fleet.user_integrations ui
     JOIN fleet.accounts a ON a.id = ui.account_id
     WHERE a.email = $1 AND ui.integration = 'semrush' AND ui.enabled = true LIMIT 1`,
    [email]
  );
  if (!r.rows.length) return null;
  return r.rows[0].credentials?.api_key || process.env.SEMRUSH_API_KEY_MARKETING || null;
}

function checkSemrushError(text, res) {
  if (typeof text !== 'string') return false;
  if (text.includes('ERROR 132')) {
    res.status(402).json({ error: 'SEMrush API credits exhausted. Please top up the account.', code: 'SEMRUSH_NO_CREDITS' });
    return true;
  }
  if (text.startsWith('ERROR')) {
    res.status(500).json({ error: text.trim() });
    return true;
  }
  return false;
}

async function semrushGet(params, res) {
  try {
    const resp = await axios.get(`${SEMRUSH_API}/`, { params, validateStatus: () => true });
    const text = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    if (text.includes('ERROR 132')) { res.status(402).json({ error: 'SEMrush API credits exhausted. Please top up the account.', code: 'SEMRUSH_NO_CREDITS' }); return null; }
    if (text.startsWith('ERROR')) { res.status(500).json({ error: text.trim() }); return null; }
    return text;
  } catch(e) { res.status(500).json({ error: e.message }); return null; }
}

app.post('/semrush/domain/overview', async (req, res) => {
  try {
    const { email, domain, database = 'us' } = req.body;
    if (!email || !domain) return res.status(400).json({ error: 'email and domain required' });
    const key = await getSemrushKey(email);
    if (!key) return res.status(403).json({ error: 'No SEMrush access for this user', code: 'SEMRUSH_NO_ACCESS' });
    const text = await semrushGet({ type: 'domain_ranks', key, export_columns: 'Dn,Rk,Or,Ot,Oc,Ad,At,Ac', domain, database }, res);
    if (!text) return;
    const rows = parseSemrushCSV(text); const r = rows[0] || {};
    res.json({ domain: r.Domain||domain, rank: r.Rank, organic_keywords: r['Organic Keywords'], organic_traffic: r['Organic Traffic'], organic_cost: r['Organic Cost'], adwords_keywords: r['Adwords Keywords'], adwords_traffic: r['Adwords Traffic'], adwords_cost: r['Adwords Cost'] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/semrush/keyword/research', async (req, res) => {
  try {
    const { email, keyword, database = 'us' } = req.body;
    if (!email || !keyword) return res.status(400).json({ error: 'email and keyword required' });
    const key = await getSemrushKey(email);
    if (!key) return res.status(403).json({ error: 'No SEMrush access for this user', code: 'SEMRUSH_NO_ACCESS' });
    const text = await semrushGet({ type: 'phrase_this', key, export_columns: 'Ph,Nq,Cp,Co,Nr,Td', phrase: keyword, database }, res);
    if (!text) return;
    const rows = parseSemrushCSV(text); const r = rows[0] || {};
    res.json({ keyword: r.Keyword||keyword, search_volume: r['Search Volume'], cpc: r.CPC, competition: r['Competition Density'], results: r['Number of Results'], trend: r.Trends });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/semrush/competitor/analysis', async (req, res) => {
  try {
    const { email, domain, database = 'us' } = req.body;
    if (!email || !domain) return res.status(400).json({ error: 'email and domain required' });
    const key = await getSemrushKey(email);
    if (!key) return res.status(403).json({ error: 'No SEMrush access for this user', code: 'SEMRUSH_NO_ACCESS' });
    const text = await semrushGet({ type: 'domain_organic_organic', key, export_columns: 'Dn,Np,Or,Ot,Oc,Ad', domain, database, display_limit: 10 }, res);
    if (!text) return;
    const rows = parseSemrushCSV(text);
    res.json({ domain, competitors: rows.map(r => ({ domain: r.Domain, common_keywords: r['Common Keywords'], organic_keywords: r['Organic Keywords'], organic_traffic: r['Organic Traffic'], organic_cost: r['Organic Cost'], adwords_keywords: r['Adwords Keywords'] })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/semrush/backlinks', async (req, res) => {
  try {
    const { email, domain } = req.body;
    if (!email || !domain) return res.status(400).json({ error: 'email and domain required' });
    const key = await getSemrushKey(email);
    if (!key) return res.status(403).json({ error: 'No SEMrush access for this user', code: 'SEMRUSH_NO_ACCESS' });
    const text = await semrushGet({ type: 'backlinks_overview', key, target: domain, target_type: 'root_domain', export_columns: 'ascore,total,domains_num,urls_num,ips_num,ipclassc_num,follows_num,nofollows_num' }, res);
    if (!text) return;
    const rows = parseSemrushCSV(text); const r = rows[0] || {};
    res.json({ domain, authority_score: r['Authority Score'], total_backlinks: r['Total Backlinks'], referring_domains: r['Domains'], referring_urls: r['URLs'], referring_ips: r['IPs'], referring_ipclass_c: r['IPs (Class C)'], dofollow: r['Follow'], nofollow: r['NoFollow'] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/semrush/keyword/bulk', async (req, res) => {
  try {
    const { email, keywords, database = 'us' } = req.body;
    if (!email || !keywords?.length) return res.status(400).json({ error: 'email and keywords[] required' });
    if (keywords.length > 100) return res.status(400).json({ error: 'Max 100 keywords per request' });
    const key = await getSemrushKey(email);
    if (!key) return res.status(403).json({ error: 'No SEMrush access for this user', code: 'SEMRUSH_NO_ACCESS' });
    const text = await semrushGet({ type: 'phrase_these', key, export_columns: 'Ph,Nq,Cp,Co,Nr', phrase: keywords.join(';'), database }, res);
    if (!text) return;
    const rows = parseSemrushCSV(text);
    res.json({ results: rows.map(r => ({ keyword: r.Keyword, search_volume: r['Search Volume'], cpc: r.CPC, competition: r['Competition Density'], results: r['Number of Results'] })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`hubspot-proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`Routing table: ${ROUTING_TABLE_PATH}`);
  console.log(`Admin tokens loaded: MarketingCRM=${!!ADMIN_TOKENS['4950628']}, OneCRM=${!!ADMIN_TOKENS['21203560']}`);
});
