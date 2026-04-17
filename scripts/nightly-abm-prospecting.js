#!/usr/bin/env node
/**
 * nightly-abm-prospecting.js
 * Fleet v2 — Nightly ABM Prospecting Script
 * Runs at 10PM PHT (14:00 UTC) via cron
 *
 * Algorithm:
 *   1. Pull APAC "No Engagement" deals from HubSpot (stage 32293246)
 *   2. Research each company via claude-haiku-4-5 — find decision-makers, assess fit
 *   3. Suppression check per contact
 *   4. Store qualified contacts in Fleet DB + markdown log
 *   5. Send morning brief to Mark G. (Telegram)
 *   6. Track processed deals to avoid re-processing
 */

import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

// ── Config ────────────────────────────────────────────────────────────────────
const ENV_PATH = '/home/dev-user/Projects/oc-fleet/.env';
const PROCESSED_FILE = '/tmp/abm-processed-deals.json';
const LOG_DIR = '/home/dev-user/cbfleet-rag-marketing/.openclaw/workspace/memory';
const FLEET_PROXY = 'http://127.0.0.1:20000';
const HS_QUERY_PROXY = 'http://127.0.0.1:19003';
const DB_URL = 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev';
const PORTAL_ID = '4950628';
const ORG_ID = 'f86d92cb-db10-43ff-9ff2-d69c319d272d';
const AGENT_ID = '792ceca1-77d9-425a-85c0-c7903eeb5b13';
const AUTH_EMAIL = 'emye@callboxinc.com';
const MARK_TG_ID = '7680515818';
const DEAL_STAGE_NO_ENGAGEMENT = '32293246';

// Quality gate exclusions
const EXCLUDED_COUNTRIES = ['india', 'china', 'malaysia'];
const EXCLUDED_INDUSTRIES = ['hr', 'human resources', 'real estate', 'training', 'education & training'];

// ── Load .env ─────────────────────────────────────────────────────────────────
const envVars = {};
try {
  fs.readFileSync(ENV_PATH, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    envVars[k] = v;
  });
} catch (e) {
  console.error('[ENV] Failed to load .env:', e.message);
}

const ANTHROPIC_KEY = envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function httpRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    const req = mod.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function loadProcessed() {
  try { return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8')); }
  catch { return []; }
}

function saveProcessed(ids) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(ids, null, 2));
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── Step 1 — Pull APAC deals from HubSpot ────────────────────────────────────
async function pullApacDeals() {
  log('[STEP 1] Pulling APAC No Engagement deals from HubSpot...');
  const body = {
    email: AUTH_EMAIL,
    portal_id: PORTAL_ID,
    object: 'deals',
    filters: [{ propertyName: 'dealstage', operator: 'EQ', value: DEAL_STAGE_NO_ENGAGEMENT }],
    properties: ['dealname', 'amount', 'dealstage', 'hubspot_owner_id'],
    limit: 50
  };
  try {
    const res = await httpRequest(`${HS_QUERY_PROXY}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, body);
    if (res.status !== 200) {
      log(`[STEP 1] HubSpot query returned ${res.status}: ${JSON.stringify(res.body)}`);
      return [];
    }
    const results = res.body?.results || res.body?.data || res.body || [];
    const deals = Array.isArray(results) ? results : [];
    log(`[STEP 1] Found ${deals.length} deals.`);
    return deals;
  } catch (e) {
    log(`[STEP 1] HubSpot query failed: ${e.message}`);
    return [];
  }
}

// Extract company name from deal name
function extractCompanyName(dealname) {
  if (!dealname) return null;
  // Deal names often look like: "Acme Corp — Q1 2026" or "Acme Corp | Outreach" or "Acme Corp"
  // Strip common suffixes
  let name = dealname
    .replace(/[\|—–-]\s*(q[1-4]\s*\d{4}|outreach|apac|no engagement|follow.?up|discovery|intro|call|meeting|demo).*/gi, '')
    .replace(/\s*[\|—–]\s*$/, '')
    .trim();
  return name || dealname.trim();
}

// ── Step 2 — Research company with Anthropic web_search tool ─────────────────
async function researchCompany(companyName, anthropic) {
  log(`[STEP 2] Researching (web): ${companyName}`);

  const prompt = `You are a B2B sales researcher. Use web search to find REAL, VERIFIED information about the company "${companyName}".

Search for:
1. "${companyName}" company overview (what they do, HQ country, industry, size)
2. "${companyName}" VP Sales OR CMO OR CRO OR "Head of Marketing" OR "Director Business Development" 2025 OR 2026
3. "${companyName}" LinkedIn decision makers

Based on ACTUAL search results only (no guessing), respond in JSON:
{
  "company": "${companyName}",
  "industry": "<industry from search>",
  "country": "<primary HQ country from search>",
  "size": "<SMB/Mid-Market/Enterprise>",
  "what_they_do": "<1-2 sentence description from search>",
  "apac_presence": <true or false>,
  "decision_makers": [
    {
      "name": "<REAL full name found in search>",
      "title": "<exact title from search>",
      "email": "<firstname.lastname@companydomain.com>"
    }
  ],
  "callbox_fit_score": "<HIGH/MEDIUM/LOW>",
  "callbox_angle": "<specific reason based on search findings>",
  "skip_reason": null
}

HARD RULES:
- Only include decision-makers you found in actual search results. If you cannot find a real person with full name, set decision_makers to [] and skip_reason to "No verified decision-maker found in search"
- If HQ country is India, China, or Malaysia → skip_reason = "Excluded country"
- If industry is HR, Real Estate, or Training → skip_reason = "Excluded industry"
- Do NOT invent names or emails. Real data only.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', // Sonnet has web search tool access
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: prompt }]
    });

    // Extract the final text response (after tool use)
    const textBlock = response.content.find(b => b.type === 'text');
    const raw = textBlock?.text?.trim() || '';
    const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    // Extract JSON from response (may have surrounding text)
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    log(`[STEP 2] Research failed for "${companyName}": ${e.message}`);
    return null;
  }
}

// ── Step 3 — Suppression check ───────────────────────────────────────────────
async function isSupressed(email) {
  try {
    const body = {
      email: AUTH_EMAIL,
      portal_id: PORTAL_ID,
      object: 'contacts',
      filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
      properties: ['email', 'hs_email_optout', 'hs_email_hard_bounce_reason'],
      limit: 1
    };
    const res = await httpRequest(`${HS_QUERY_PROXY}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, body);
    if (res.status !== 200) return false; // On error, don't suppress
    const results = res.body?.results || res.body?.data || res.body || [];
    const contacts = Array.isArray(results) ? results : [];
    if (contacts.length === 0) return false;
    // Check if opted out or hard bounced
    const props = contacts[0]?.properties || contacts[0] || {};
    if (props.hs_email_optout === 'true' || props.hs_email_optout === true) return true;
    if (props.hs_email_hard_bounce_reason) return true;
    // Contact exists — it's already in HubSpot, consider suppressed for ABM purposes
    return true;
  } catch (e) {
    log(`[STEP 3] Suppression check error for ${email}: ${e.message}`);
    return false;
  }
}

// ── Step 4 — Store in Fleet DB ────────────────────────────────────────────────
async function storeProspect(contact, companyInfo) {
  const dateStr = todayStr();
  const content = `ABM PROSPECT — ${dateStr}\nCompany: ${companyInfo.company}\nContact: ${contact.name} | ${contact.title} | ${contact.email}\nCountry: ${companyInfo.country}\nIndustry: ${companyInfo.industry}\nSize: ${companyInfo.size}\nAPAC Presence: ${companyInfo.apac_presence}\nWhat they do: ${companyInfo.what_they_do}\nPriority: ${companyInfo.callbox_fit_score}\nCallbox angle: ${companyInfo.callbox_angle}\nSource: No Engagement deal`;

  try {
    const res = await httpRequest(`${FLEET_PROXY}/fleet-api/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      org_id: ORG_ID,
      agent_id: AGENT_ID,
      memory_type: 'episodic',
      visibility: 'org',
      salience: 0.85,
      content
    });
    if (res.status === 200 || res.status === 201) {
      log(`[STEP 4] Stored: ${contact.name} @ ${companyInfo.company}`);
      return true;
    } else {
      log(`[STEP 4] Store failed (${res.status}): ${JSON.stringify(res.body)}`);
      return false;
    }
  } catch (e) {
    log(`[STEP 4] Store error for ${contact.name}: ${e.message}`);
    return false;
  }
}

// Write daily markdown log
function writeMarkdownLog(prospects) {
  const dateStr = todayStr();
  const logPath = path.join(LOG_DIR, `abm-nightly-${dateStr}.md`);
  const lines = [
    `# ABM Nightly Log — ${dateStr}`,
    '',
    `**Total prospects added:** ${prospects.length}`,
    '',
    '---',
    ''
  ];
  for (const p of prospects) {
    lines.push(`## ${p.company} — ${p.contact.name}`);
    lines.push(`- **Contact:** ${p.contact.name} | ${p.contact.title} | ${p.contact.email}`);
    lines.push(`- **Country:** ${p.country}`);
    lines.push(`- **Industry:** ${p.industry}`);
    lines.push(`- **Size:** ${p.size}`);
    lines.push(`- **Priority:** ${p.priority}`);
    lines.push(`- **Callbox angle:** ${p.angle}`);
    lines.push(`- **What they do:** ${p.what_they_do}`);
    lines.push('');
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(logPath, lines.join('\n'));
    log(`[STEP 4] Wrote markdown log: ${logPath}`);
  } catch (e) {
    log(`[STEP 4] Failed to write markdown log: ${e.message}`);
  }
}

// ── Step 5 — Send morning brief to Mark ─────────────────────────────────────
async function notifyMark(prospects) {
  const highPriority = prospects.filter(p => p.priority === 'HIGH');
  const top3 = highPriority.slice(0, 3);

  let text;
  if (prospects.length === 0) {
    text = `🌅 Good morning Mark!\n\nNightly ABM complete — pipeline is clean today. No new qualified prospects found from the No Engagement deals.\n\nWe'll check again tonight!`;
  } else {
    const top3Lines = top3.map((p, i) =>
      `${i + 1}. ${p.contact.name} — ${p.company} — ${p.angle}`
    ).join('\n');

    text = `🌅 Good morning Mark! Nightly ABM complete.\n\nAdded ${prospects.length} new contact${prospects.length !== 1 ? 's' : ''}.\n\nTOP ${top3.length} HIGH priority:\n${top3Lines || '(none this run)'}\n\nFull details in today's ABM log: abm-nightly-${todayStr()}.md`;
  }

  try {
    const res = await httpRequest(`${FLEET_PROXY}/fleet-api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { to: MARK_TG_ID, text });
    if (res.status === 200 || res.status === 201) {
      log('[STEP 5] Morning brief sent to Mark.');
    } else {
      log(`[STEP 5] Notify failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
  } catch (e) {
    log(`[STEP 5] Notify error: ${e.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('=== Nightly ABM Prospecting — START ===');

  if (!ANTHROPIC_KEY) {
    log('[ERROR] ANTHROPIC_API_KEY not found. Aborting.');
    process.exit(1);
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

  // Load processed deals
  const processedIds = loadProcessed();
  log(`[INIT] Already processed: ${processedIds.length} deal(s)`);

  // STEP 1 — Pull deals
  const deals = await pullApacDeals();
  if (deals.length === 0) {
    log('[STEP 1] No deals found. Sending clean-pipeline notice to Mark.');
    await notifyMark([]);
    log('=== Nightly ABM Prospecting — DONE (no deals) ===');
    return;
  }

  // Filter already-processed
  const newDeals = deals.filter(d => {
    const id = d.id || d.hs_object_id || d.properties?.hs_object_id;
    return id && !processedIds.includes(String(id));
  });
  log(`[STEP 1] New (unprocessed) deals: ${newDeals.length}`);

  if (newDeals.length === 0) {
    log('[STEP 1] All deals already processed. Sending clean-pipeline notice to Mark.');
    await notifyMark([]);
    log('=== Nightly ABM Prospecting — DONE (all processed) ===');
    return;
  }

  const addedProspects = [];
  const newProcessedIds = [...processedIds];

  for (const deal of newDeals) {
    const dealId = String(deal.id || deal.hs_object_id || deal.properties?.hs_object_id || '');
    const dealname = deal.properties?.dealname || deal.dealname || '';
    const companyName = extractCompanyName(dealname);

    if (!companyName) {
      log(`[SKIP] Deal ${dealId} has no extractable company name from: "${dealname}"`);
      if (dealId) newProcessedIds.push(dealId);
      continue;
    }

    log(`[DEAL] ${dealId} → "${companyName}"`);

    // STEP 2 — Research
    const info = await researchCompany(companyName, anthropic);
    if (!info) {
      log(`[SKIP] ${companyName}: Research failed`);
      if (dealId) newProcessedIds.push(dealId);
      continue;
    }

    // Quality gate
    if (info.skip_reason && info.skip_reason !== 'null') {
      log(`[SKIP] ${companyName}: ${info.skip_reason}`);
      if (dealId) newProcessedIds.push(dealId);
      continue;
    }

    const countryLower = (info.country || '').toLowerCase();
    const industryLower = (info.industry || '').toLowerCase();

    if (EXCLUDED_COUNTRIES.some(c => countryLower.includes(c))) {
      log(`[SKIP] ${companyName}: Excluded country (${info.country})`);
      if (dealId) newProcessedIds.push(dealId);
      continue;
    }
    if (EXCLUDED_INDUSTRIES.some(i => industryLower.includes(i))) {
      log(`[SKIP] ${companyName}: Excluded industry (${info.industry})`);
      if (dealId) newProcessedIds.push(dealId);
      continue;
    }

    const dms = info.decision_makers || [];
    if (dms.length === 0) {
      log(`[SKIP] ${companyName}: No decision-makers found`);
      if (dealId) newProcessedIds.push(dealId);
      continue;
    }

    // STEP 3 — Suppression check + STEP 4 — Store
    for (const dm of dms.slice(0, 2)) {
      if (!dm.name || !dm.email) continue;

      const suppressed = await isSupressed(dm.email);
      if (suppressed) {
        log(`[STEP 3] Suppressed: ${dm.email} — skipping`);
        continue;
      }

      const stored = await storeProspect(dm, info);
      if (stored) {
        addedProspects.push({
          company: info.company,
          contact: { name: dm.name, title: dm.title, email: dm.email },
          country: info.country,
          industry: info.industry,
          size: info.size,
          priority: info.callbox_fit_score,
          angle: info.callbox_angle,
          what_they_do: info.what_they_do
        });
      }
    }

    if (dealId) newProcessedIds.push(dealId);

    // Small delay to avoid hammering Anthropic
    await new Promise(r => setTimeout(r, 1500));
  }

  // Save processed IDs
  saveProcessed(newProcessedIds);

  // Write markdown log
  if (addedProspects.length > 0) {
    writeMarkdownLog(addedProspects);
  }

  log(`[SUMMARY] Added ${addedProspects.length} prospect(s) this run.`);

  // STEP 5 — Send morning brief
  await notifyMark(addedProspects);

  log('=== Nightly ABM Prospecting — DONE ===');
}

main().catch(e => {
  console.error('[FATAL]', e);
  process.exit(1);
});
