#!/usr/bin/env node
/**
 * sales-meeting-intel-webhook.js
 * Fleet v2 — Sales Meeting Intel Webhook Handler
 * Standalone ESM module — no OpenClaw dependency
 *
 * Exports: handleSalesMeetingIntelWebhook(payload)
 * Called by fleet proxy on: POST /fleet-api/hooks/sales-meeting-intel
 *
 * Flows:
 *   pre-meeting  — PRE-MEETING + ICP+TAM prompts → Google Doc → Telegram DM
 *   post-meeting — POST-MEETING prompt → Google Doc → Telegram DM
 */

import fs from 'fs';
import http from 'http';
import https from 'https';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('pg');

// ── Config ────────────────────────────────────────────────────────────────────
const PORTAL_ID        = 4950628;
const HUBSPOT_PROXY    = 'http://127.0.0.1:19003';   // eslint-disable-line no-unused-vars
const GOOGLE_AUTH_PROXY = 'http://127.0.0.1:19001';
const FLEET_PROXY      = 'http://127.0.0.1:20000';
const ORG_ID           = 'f86d92cb-db10-43ff-9ff2-d69c319d272d'; // eslint-disable-line no-unused-vars
const FALLBACK_TG_ID   = '8618648518'; // Sheryll Colindres
const HS_BASE          = 'https://api.hubapi.com';
const DB_URL           = 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev';

// ── Load .env ─────────────────────────────────────────────────────────────────
const ENV_PATH = '/home/dev-user/Projects/oc-fleet/.env';
const envVars = {};
try {
  fs.readFileSync(ENV_PATH, 'utf8').split('\n').forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const idx = t.indexOf('=');
    if (idx === -1) return;
    envVars[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  });
} catch (e) {
  console.error('[SMI] Failed to load .env:', e.message);
}

const ANTHROPIC_API_KEY = envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
const HS_ADMIN_TOKEN    = envVars.HUBSPOT_ADMIN_TOKEN_MARKETING_CRM || process.env.HUBSPOT_ADMIN_TOKEN_MARKETING_CRM;

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpReq(url, method, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const bodyStr = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr != null ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...extraHeaders
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const hsGet   = (path)         => httpReq(`${HS_BASE}${path}`, 'GET',   null, { Authorization: `Bearer ${HS_ADMIN_TOKEN}` });
const hsPatch = (path, body)   => httpReq(`${HS_BASE}${path}`, 'PATCH', body, { Authorization: `Bearer ${HS_ADMIN_TOKEN}` });
const proxyPost = (url, body)  => httpReq(url, 'POST', body);

// ── HubSpot: fetch contact ────────────────────────────────────────────────────
async function fetchContact(contactId) {
  const props = [
    'company', 'firstname', 'lastname', 'jobtitle', 'website',
    'hs_lead_source', 'hubspot_owner_id',
    'callbox_premeet_generated', 'callbox_postmeet_generated'
  ].join(',');
  const r = await hsGet(`/crm/objects/2026-03/contacts/${contactId}?properties=${props}`);
  if (r.status !== 200) throw new Error(`HubSpot contact fetch failed (${r.status}): ${JSON.stringify(r.body)}`);
  return r.body.properties || {};
}

// ── HubSpot: mark contact property ───────────────────────────────────────────
async function markContact(contactId, properties) {
  const r = await hsPatch(`/crm/objects/2026-03/contacts/${contactId}`, { properties });
  if (r.status >= 300) throw new Error(`HubSpot PATCH failed (${r.status}): ${JSON.stringify(r.body)}`);
}

// ── HubSpot: get owner email ──────────────────────────────────────────────────
async function fetchOwnerEmail(ownerId) {
  if (!ownerId) return null;
  try {
    const r = await hsGet(`/crm/v3/owners/${ownerId}`);
    return r.body?.email || null;
  } catch {
    return null;
  }
}

// ── Fleet DB: resolve owner Telegram ID from email ───────────────────────────
async function getOwnerTelegramId(ownerEmail) {
  if (!ownerEmail) return FALLBACK_TG_ID;
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    const r = await client.query(
      `SELECT tb.telegram_id
       FROM fleet.accounts a
       JOIN fleet.telegram_bindings tb ON tb.account_id = a.id
       WHERE LOWER(a.email) = LOWER($1)
       LIMIT 1`,
      [ownerEmail]
    );
    return r.rows[0]?.telegram_id || FALLBACK_TG_ID;
  } catch (e) {
    console.error('[SMI] TG lookup error:', e.message);
    return FALLBACK_TG_ID;
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Google Doc creation ───────────────────────────────────────────────────────
async function createDoc(ownerEmail, title, content) {
  const r = await proxyPost(`${GOOGLE_AUTH_PROXY}/docs/create`, { email: ownerEmail, title, content });
  if (!r.body?.ok) throw new Error(`Google Doc creation failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

// ── Telegram DM via fleet proxy ───────────────────────────────────────────────
async function sendTelegramDM(telegramId, message) {
  const r = await proxyPost(`${FLEET_PROXY}/fleet-api/notify`, {
    telegram_id: String(telegramId),
    message
  });
  if (r.status >= 300) {
    console.warn('[SMI] Telegram notify warn:', r.status, JSON.stringify(r.body));
  }
}

// ── Anthropic: run a prompt ───────────────────────────────────────────────────
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  return _anthropic;
}

async function runPrompt(promptText) {
  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: promptText }]
  });
  return msg.content[0]?.text || '';
}

// ── Prompts (verbatim from /tmp/smi-prompts.md) ───────────────────────────────
function buildPreMeetingPrompt(name, jobTitle, company, website) {
  return `ROLE
You are a senior strategic marketing advisor and B2B lead-generation specialist in [PROSPECT_INDUSTRY].
I am the VP of Business Development at Callbox (callboxinc.com), a global B2B lead-generation and sales-enablement company.

CONTEXT
I have an upcoming exploratory call with ${name}, ${jobTitle} at ${company} (${website}). Using their website and publicly available information, determine their most likely target geography and lead generation scope.

DELIVERABLES
1. Prospect Context
   Short business profile: industry focus, company size, target markets, growth signals
   Likely decision-makers Callbox should engage on their behalf: job titles and buying centers

2. ICP Hypothesis
   Ideal customer profile based on their industry and target geography
   Pain points, buying triggers, and objections relevant to their buyer personas

3. Call Prep
   3 to 5 probing questions to uncover gaps in their current marketing and lead generation activities

4. Company Intel (for proposal use)
   HQ address, phone number, corporate email, LinkedIn page
   Estimated annual revenue and any recent funding
   Top 3 competitors and their websites

Do not use em dashes.`;
}

function buildIcpTamPrompt(company, website) {
  return `ROLE
You are a senior B2B market research analyst specializing in [PROSPECT_INDUSTRY].

CONTEXT
I am preparing a lead-generation proposal for ${company} (${website}), a company targeting [TARGET_GEOGRAPHY].

DELIVERABLES
1. Buyer Personas
   Key decision-maker titles and buying centers for ${company}'s ideal customers
   Include: database infrastructure leaders, cloud/DevOps teams, IT leadership, solution architects (adjust for their industry)

2. Target Geographies
   Primary and secondary markets based on their business model and growth signals

3. Pain Points and Buying Triggers
   Top 3 pain points their buyers face
   Buying triggers that signal readiness for outsourced lead generation

4. Objections
   Common objections to outsourced lead generation in their industry and how to address them

Do not use em dashes.`;
}

function buildPostMeetingPrompt(name, jobTitle, company, website, callNotes) {
  return `ROLE
You are a senior B2B sales strategist and revenue intelligence analyst.
I am the VP of Business Development at Callbox (callboxinc.com), a global B2B lead-generation and sales-enablement company.

CONTEXT
I just completed an exploratory call with ${name}, ${jobTitle} at ${company} (${website}).
Here are the call notes:

${callNotes}

DELIVERABLES
1. Prospect Context
   Updated business profile based on call insights: pain points confirmed, key stakeholders identified, budget signals

2. ICP Hypothesis
   Refined ideal customer profile based on what was discussed
   Adjusted pain points, buying triggers, and objections from the actual conversation

3. Transcript Intelligence
   Key quotes or signals from the call notes
   Red flags or objections raised
   Positive buying signals

4. Strategic Call Prep (for next meeting)
   Recommended next steps and follow-up questions
   Proposal angles to emphasize based on this call

5. Competitive Landscape
   Competitors mentioned or implied during the call
   Positioning recommendations

6. Corporate Intelligence
   Any new company details revealed during the call (team size, budget, timeline, tech stack)

7. Follow-up Email Draft
   A concise, professional follow-up email to ${name} summarizing key points and next steps

Do not use em dashes.`;
}

// ── Main exported handler ─────────────────────────────────────────────────────
export async function handleSalesMeetingIntelWebhook(payload) {
  const { flow, contact_id, owner_id, call_notes, portal_id } = payload;
  const today = new Date().toISOString().slice(0, 10);

  // Validate portal
  if (String(portal_id) !== String(PORTAL_ID)) {
    console.warn(`[SMI] Rejected: portal_id ${portal_id} !== ${PORTAL_ID}`);
    return { ok: false, error: 'invalid_portal' };
  }

  if (!contact_id) {
    console.warn('[SMI] Rejected: missing contact_id');
    return { ok: false, error: 'missing_contact_id' };
  }

  console.log(`[SMI] Handling flow="${flow}" contact=${contact_id}`);

  // Fetch contact from HubSpot 2026-03 API
  const props = await fetchContact(contact_id);
  const name     = `${props.firstname || ''} ${props.lastname || ''}`.trim() || 'Unknown';
  const company  = props.company   || 'Unknown Company';
  const jobTitle = props.jobtitle  || 'Unknown Title';
  const website  = props.website   || company;
  const ownerId  = owner_id || props.hubspot_owner_id || null;

  // Resolve owner contact info
  const ownerEmail = await fetchOwnerEmail(ownerId);
  const telegramId = await getOwnerTelegramId(ownerEmail);

  // ── PRE-MEETING ────────────────────────────────────────────────────────────
  if (flow === 'pre-meeting') {
    if (props.callbox_premeet_generated === 'true') {
      console.log(`[SMI] pre-meeting already generated for contact ${contact_id}, skipping`);
      return { ok: true, skipped: true };
    }

    console.log(`[SMI] Running PRE-MEETING + ICP+TAM for ${name} @ ${company}`);
    const [preMeeting, icpTam] = await Promise.all([
      runPrompt(buildPreMeetingPrompt(name, jobTitle, company, website)),
      runPrompt(buildIcpTamPrompt(company, website))
    ]);

    const docTitle   = `PRE-MEETING \u2014 ${name} ${company} ${today}`;
    const docContent = [
      `PRE-MEETING INTEL`,
      `Contact: ${name} | ${jobTitle} | ${company}`,
      `Date: ${today}`,
      ``,
      `=== PRE-MEETING BRIEF ===`,
      ``,
      preMeeting,
      ``,
      `=== ICP + TAM ANALYSIS ===`,
      ``,
      icpTam
    ].join('\n');

    const doc = await createDoc(ownerEmail, docTitle, docContent);
    console.log(`[SMI] Doc created: ${doc.url}`);

    await sendTelegramDM(
      telegramId,
      `PRE-MEETING intel ready for ${name} at ${company}\n\nDoc: ${doc.url}`
    );

    await markContact(contact_id, { callbox_premeet_generated: 'true' });
    console.log(`[SMI] pre-meeting complete for contact ${contact_id}`);
    return { ok: true, doc_url: doc.url };
  }

  // ── POST-MEETING ───────────────────────────────────────────────────────────
  if (flow === 'post-meeting') {
    if (props.callbox_postmeet_generated === 'true') {
      console.log(`[SMI] post-meeting already generated for contact ${contact_id}, skipping`);
      return { ok: true, skipped: true };
    }

    const notes = call_notes || payload.hs_call_body || '(no call notes provided)';
    console.log(`[SMI] Running POST-MEETING for ${name} @ ${company}`);
    const postMeeting = await runPrompt(
      buildPostMeetingPrompt(name, jobTitle, company, website, notes)
    );

    const docTitle   = `POST-MEETING \u2014 ${name} ${company} ${today}`;
    const docContent = [
      `POST-MEETING INTEL`,
      `Contact: ${name} | ${jobTitle} | ${company}`,
      `Date: ${today}`,
      ``,
      postMeeting
    ].join('\n');

    const doc = await createDoc(ownerEmail, docTitle, docContent);
    console.log(`[SMI] Doc created: ${doc.url}`);

    await sendTelegramDM(
      telegramId,
      `POST-MEETING debrief ready for ${name} at ${company}\n\nDoc: ${doc.url}`
    );

    await markContact(contact_id, { callbox_postmeet_generated: 'true' });
    console.log(`[SMI] post-meeting complete for contact ${contact_id}`);
    return { ok: true, doc_url: doc.url };
  }

  console.warn(`[SMI] Unknown flow: ${flow}`);
  return { ok: false, error: `unknown_flow: ${flow}` };
}
