#!/usr/bin/env node
// =============================================================================
// oc-fleet — Handoff Delivery Worker
// Polls fleet.handoffs for pending unnotified handoffs and delivers them
// to the target agent(s) via OpenClaw gateway system events.
//
// Targeting modes:
//   user       → inject into specific agent's session for a specific telegram user
//   agent      → inject into agent's general context (no specific user)
//   department → inject into all agents in the department
//   org        → inject into all active agents org-wide
//
// Run: node scripts/handoff-worker.js
// Cron: */1 * * * * node /path/to/scripts/handoff-worker.js >> /tmp/fleet-handoff-worker.log 2>&1
// =============================================================================

'use strict';

const { Client } = require('pg');
const http = require('http');

// ── Config ────────────────────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev';
const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:20000';
const ORG_ID = process.env.ORG_ID || 'f86d92cb-db10-43ff-9ff2-d69c319d272d';

// Agent gateway map — loaded from DB (fleet.agents.gateway_port/token)
// Fallback to env vars if DB columns not populated
const AGENT_GATEWAY_MAP = {
  // slug → { port, token }
  // Populated at runtime from DB or env
};

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpPost(url, body, token = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST', headers
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Proxy helper ──────────────────────────────────────────────────────────────
async function proxyPost(endpoint, body) {
  const r = await httpPost(`${PROXY_URL}/fleet-api/${endpoint}`, body);
  return r.body;
}

// ── Send Telegram message directly via Bot API ────────────────────────
async function sendTelegramMessage(botToken, chatId, text) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Deliver handoff to agent ────────────────────────────────────────────────
async function injectToAgent(agentInfo, text, telegramId = null, targetType = 'org') {
  const { gateway_port, hooks_token, name } = agentInfo;
  if (!gateway_port || !hooks_token) {
    console.warn(`[worker] No hooks config for agent: ${name}`);
    return { success: false, error: 'no_hooks_config' };
  }

  try {
    let r;

    if (telegramId && agentInfo.bot_token) {
      // Send DIRECTLY via Telegram Bot API — no agent involvement, clean notification
      const tgResult = await sendTelegramMessage(agentInfo.bot_token, telegramId, text);
      if (tgResult.ok) {
        console.log(`[worker] ✅ Direct Telegram → ${name} bot → user:${telegramId}`);
        return { success: true };
      }
      console.warn(`[worker] ⚠️ Telegram API error for ${name}: ${JSON.stringify(tgResult)}`);
      return { success: false, error: JSON.stringify(tgResult) };
    } else if (gateway_port && hooks_token) {
      // Fallback: wake agent (no user message)
      r = await httpPost(
        `http://127.0.0.1:${gateway_port}/hooks/wake`,
        { text, mode: 'now' },
        hooks_token
      );
      if (r.body?.ok) {
        console.log(`[worker] ✅ Wake → ${name}`);
        return { success: true };
      }
      return { success: false, error: JSON.stringify(r.body) };
    } else {
      return { success: false, error: 'no_delivery_method' };
    }
  } catch (e) {
    console.error(`[worker] ❌ Failed to inject to ${name}: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ── Build handoff system event text ──────────────────────────────────────────
function buildEventText(handoff, fromAgentName, userName) {
  if (handoff.target_type === 'org') {
    return `📢 *Org-wide message from ${userName || fromAgentName}*\n\n${handoff.summary}`;
  }
  if (handoff.target_type === 'department') {
    return `📢 *Dept message [${handoff.department}] from ${userName || fromAgentName}*\n\n${handoff.summary}`;
  }
  // user/agent handoff
  return `📩 *Handoff from ${fromAgentName}*\n\n*From:* ${userName || 'Unknown'}\n*Message:* ${handoff.summary}${handoff.next_action ? `\n*Next:* ${handoff.next_action}` : ''}`;
}

// ── Ensure active session exists for user+agent ───────────────────────────────
async function ensureSession(agentId, telegramId, chatType = 'direct') {
  try {
    const r = await proxyPost('session/active', {
      org_id: ORG_ID,
      agent_id: agentId,
      platform_chat_id: telegramId,
      chat_type: chatType
    });
    return r;
  } catch (e) {
    console.warn(`[worker] Could not ensure session for ${telegramId}: ${e.message}`);
    return null;
  }
}

// ── Main worker ───────────────────────────────────────────────────────────────
async function run() {
  const pg = new Client({ connectionString: DB_URL });
  await pg.connect();

  try {
    // Load agent gateway configs from DB
    const agentsR = await pg.query(
      `SELECT id, name, slug, gateway_port, gateway_token, hooks_token, bot_token, status, department_id
       FROM fleet.agents WHERE org_id = $1 AND status = 'active'`,
      [ORG_ID]
    );

    const agentMap = {}; // id → agent row
    for (const a of agentsR.rows) {
      // Prefer DB-stored port/token, fall back to env vars
      const envSlug = a.slug.toUpperCase().replace(/-/g, '_');
      a.port  = a.gateway_port  || parseInt(process.env[`GATEWAY_PORT_${envSlug}`]  || 0);
      a.token = a.gateway_token || process.env[`GATEWAY_TOKEN_${envSlug}`] || null;
      agentMap[a.id] = a;
    }

    // Load department → agents mapping
    const deptR = await pg.query(
      `SELECT a.id, a.department_id, d.slug AS dept_slug
       FROM fleet.agents a
       LEFT JOIN fleet.departments d ON d.id = a.department_id
       WHERE a.org_id = $1 AND a.status = 'active'`,
      [ORG_ID]
    );
    const deptAgents = {}; // dept_slug → [agent_id]
    for (const row of deptR.rows) {
      if (row.dept_slug) {
        deptAgents[row.dept_slug] = deptAgents[row.dept_slug] || [];
        deptAgents[row.dept_slug].push(row.id);
      }
    }

    // Fetch pending unnotified handoffs
    const handoffsR = await pg.query(
      `SELECT h.*,
              fa.name AS from_agent_name,
              ta.name AS to_agent_name, ta.slug AS to_agent_slug,
              ta.department_id AS to_dept_id,
              acc.name AS user_name,
              tb.telegram_id AS user_telegram_id
       FROM fleet.handoffs h
       JOIN fleet.agents fa ON fa.id = h.from_agent_id
       JOIN fleet.agents ta ON ta.id = h.to_agent_id
       LEFT JOIN fleet.accounts acc ON acc.id = h.user_id
       LEFT JOIN fleet.telegram_bindings tb ON tb.account_id = h.user_id AND tb.org_id = h.org_id
       WHERE h.org_id = $1
         AND h.status = 'pending'
         AND h.notified_at IS NULL
       ORDER BY h.created_at ASC
       LIMIT 20`,
      [ORG_ID]
    );

    if (handoffsR.rows.length === 0) {
      console.log(`[worker] No pending handoffs.`);
      return;
    }

    console.log(`[worker] Processing ${handoffsR.rows.length} handoff(s)...`);

    for (const handoff of handoffsR.rows) {
      const telegramId = handoff.telegram_id || handoff.user_telegram_id;
      const userName = handoff.user_name || telegramId;
      const eventText = buildEventText(handoff, handoff.from_agent_name, userName);
      const notifiedAgents = [];
      let hasError = null;

      // ── Determine target agents ────────────────────────────────────────────
      let targetAgentIds = [];

      if (handoff.target_type === 'org') {
        // All active agents in org
        targetAgentIds = Object.keys(agentMap);
        console.log(`[worker] Handoff ${handoff.id}: ORG-WIDE → ${targetAgentIds.length} agents`);

      } else if (handoff.target_type === 'department') {
        // All agents in the target department
        const deptSlug = handoff.department;
        targetAgentIds = deptAgents[deptSlug] || [];
        if (targetAgentIds.length === 0) {
          // Try by department_id
          const dR = await pg.query(
            `SELECT id FROM fleet.agents WHERE department_id = (
              SELECT id FROM fleet.departments WHERE slug=$1 AND org_id=$2
            ) AND status='active'`,
            [deptSlug, ORG_ID]
          );
          targetAgentIds = dR.rows.map(r => r.id);
        }
        console.log(`[worker] Handoff ${handoff.id}: DEPT [${deptSlug}] → ${targetAgentIds.length} agents`);

      } else {
        // user or agent — specific to_agent_id
        targetAgentIds = [handoff.to_agent_id];
        console.log(`[worker] Handoff ${handoff.id}: ${handoff.target_type?.toUpperCase()} → ${handoff.to_agent_name}`);
      }

      // ── Deliver to each target agent ───────────────────────────────────────
      for (const agentId of targetAgentIds) {
        const agentInfo = agentMap[agentId];
        if (!agentInfo) {
          console.warn(`[worker] Agent ${agentId} not found in map — skipping`);
          continue;
        }

        // For user-targeted handoffs, ensure session exists first
        if ((handoff.target_type === 'user') && telegramId) {
          const sessR = await ensureSession(agentId, telegramId, 'direct');
          if (sessR?.session_id) {
            console.log(`[worker] Session #${sessR.session_number} ready for ${agentInfo.name} ↔ ${userName} (is_new=${sessR.is_new})`);
          }
        }

        const result = await injectToAgent(agentInfo, eventText, telegramId, handoff.target_type);
        notifiedAgents.push({
          agent_id: agentId,
          agent_name: agentInfo.name,
          port: agentInfo.port,
          notified_at: new Date().toISOString(),
          success: result.success,
          error: result.error || null
        });

        if (!result.success) hasError = result.error;
      }

      // ── Mark handoff as notified ───────────────────────────────────────────
      const successCount = notifiedAgents.filter(a => a.success).length;
      const totalTargets = notifiedAgents.length;
      // Status: 'notified' if at least 1 delivered, 'failed' if all failed
      const newStatus = successCount > 0 ? 'notified' : 'failed';

      await pg.query(
        `UPDATE fleet.handoffs
         SET notified_at = now(),
             status = $1,
             notified_agents = $2::jsonb,
             delivery_error = $3,
             updated_at = now()
         WHERE id = $4`,
        [newStatus, JSON.stringify(notifiedAgents), hasError, handoff.id]
      );

      console.log(`[worker] Handoff ${handoff.id} → ${newStatus} (${successCount}/${totalTargets} agents)`);
    }

  } catch (e) {
    console.error('[worker] Fatal error:', e.message);
    process.exit(1);
  } finally {
    await pg.end();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
