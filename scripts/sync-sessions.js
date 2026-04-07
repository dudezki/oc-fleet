#!/usr/bin/env node
// sync-sessions.js — backend session sync (NO LLM involvement)
// Reads OpenClaw JSONL session files, extracts user+assistant messages,
// and logs them to fleet.conversations/messages via the proxy.
// Run on a cron or via /api/sync-sessions from dashboard.

const fs   = require('fs');
const path = require('path');
const http = require('http');
const os   = require('os');

const PROXY  = 'http://127.0.0.1:20000';
const ORG_ID = 'f86d92cb-db10-43ff-9ff2-d69c319d272d';

// ── Agent registry — pulled from DB at runtime, fallback to hardcoded ────────
const AGENT_FALLBACK = [
  { slug: 'sales',   id: 'b81c0d8a-3f76-43fe-b2e5-2537801085dc' },
  { slug: 'support', id: '325e5143-3c0b-4d65-b548-a34cbdba5949' },
  { slug: 'manager', id: '82061d1c-2c79-4cfb-9e18-b8233b95a7c2' },
  { slug: 'dev',     id: '87a2838e-e145-4f5c-99e2-c759f0591cba' },
  { slug: 'it',      id: '20dc090b-90a3-403f-acc3-a1ac7008596d' },
  { slug: 'hr',      id: '8a2ce3b0-ed67-460b-a79e-e3baeeacc51e' },
];

const STATE_FILE = path.join(os.homedir(), '.cbfleet-sync-state.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function post(endpoint, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: 20000, path: `/fleet-api/${endpoint}`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 8000 },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); }
    );
    req.on('error', () => resolve({}));
    req.on('timeout', () => { req.destroy(); resolve({}); });
    req.write(data);
    req.end();
  });
}

// ── Content cleaners ──────────────────────────────────────────────────────────
function extractTelegramId(raw) {
  const m = raw.match(/"sender_id":\s*"(\d+)"/);
  return m ? m[1] : null;
}

function extractSenderName(raw) {
  const m = raw.match(/"sender":\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function extractChatId(raw) {
  // Try inbound_meta chat_id field first (e.g. "chat_id": "telegram:-5117379505")
  const metaM = raw.match(/"chat_id":\s*"(?:telegram:)?(-?\d+)"/);
  if (metaM) return metaM[1];
  // Fallback: conversation_label format "CB Fleet GC id:-5117379505"
  const labelM = raw.match(/id:(-\d+)/);
  if (labelM) return labelM[1];
  return null;
}

function extractIsGroup(raw) {
  return /"is_group_chat":\s*true/.test(raw) || /"chat_type":\s*"group"/.test(raw);
}

function extractGroupSubject(raw) {
  const m = raw.match(/"group_subject":\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function cleanContent(raw) {
  return raw
    .replace(/Conversation info \(untrusted metadata\):[\s\S]*?(?=\n\n|\n[A-Z#]|$)/g, '')
    .replace(/Sender \(untrusted metadata\):[\s\S]*?(?=\n\n|$)/g, '')
    .replace(/\[Telegram[\s\S]*?\]/g, '')
    .replace(/\[\[reply_to[^\]]*\]\]/g, '')
    .replace(/<<HUMAN_CONVERSATION_START>>/g, '')
    .replace(/\[media attached:[^\]]*\]/g, '[media]')
    .replace(/^---\s*$/gm, '')
    .trim();
}

// ── Per-agent sync ────────────────────────────────────────────────────────────
async function syncAgent(agent) {
  const sessDir = path.join(os.homedir(), `cbfleet-rag-${agent.slug}`, '.openclaw', 'agents', 'main', 'sessions');
  if (!fs.existsSync(sessDir)) return { synced: 0 };

  // Process all session files, most recent first
  const files = fs.readdirSync(sessDir)
    .filter(f => f.endsWith('.jsonl') && !f.includes('.reset'))
    .map(f => ({ f, mtime: fs.statSync(path.join(sessDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  let totalSynced = 0;

  for (const { f } of files) {
    const sessionFile = path.join(sessDir, f);
    const stateKey = `${agent.slug}:${f}`;
    const lastTs = state[stateKey] || 0;

    const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
    const toSync = [];
    let latestTs = lastTs;

    // Track last seen GC context so assistant messages inherit the correct conversation bucket
    let lastChatId = null;
    let lastIsGroup = false;
    let lastGroupSubject = null;
    let lastTelegramId = null;
    let lastTelegramName = null;

    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (d.type !== 'message') continue;
        const msg = d.message || {};
        if (!['user', 'assistant'].includes(msg.role)) continue;

        const ts = new Date(d.timestamp).getTime();
        if (ts <= lastTs) continue;
        if (ts > latestTs) latestTs = ts;

        // Flatten content
        let rawText = Array.isArray(msg.content)
          ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          : String(msg.content || '');

        // Extract telegram metadata from user messages; assistant messages inherit last seen context
        let telegram_id = null;
        let telegram_name = null;
        let chat_id = null;
        let is_group = false;
        let group_subject = null;
        if (msg.role === 'user') {
          telegram_id = extractTelegramId(rawText) || lastTelegramId;
          telegram_name = extractSenderName(rawText) || lastTelegramName;
          chat_id = extractChatId(rawText);
          is_group = extractIsGroup(rawText);
          if (is_group) group_subject = extractGroupSubject(rawText);
          // Update rolling context
          lastChatId = chat_id || lastChatId;
          lastIsGroup = is_group || lastIsGroup;
          lastGroupSubject = group_subject || lastGroupSubject;
          lastTelegramId = telegram_id || lastTelegramId;
          lastTelegramName = telegram_name || lastTelegramName;
        } else {
          // Assistant message — inherit context from last user message
          telegram_id = lastTelegramId;
          telegram_name = lastTelegramName;
          chat_id = lastChatId;
          is_group = lastIsGroup;
          group_subject = lastGroupSubject;
        }

        const content = cleanContent(rawText);
        if (!content || content.length < 2) continue;

        // Skip heartbeat/system noise
        if (msg.role === 'user' && content.includes('Read HEARTBEAT.md')) continue;
        if (msg.role === 'assistant' && content.trim() === 'HEARTBEAT_OK') continue;
        if (msg.role === 'assistant' && content.trim() === 'NO_REPLY') continue;

        let usage = {};
        if (msg.role === 'assistant' && msg.usage && msg.usage.totalTokens > 0) {
          usage = {
            input_tokens:       msg.usage.input       || 0,
            output_tokens:      msg.usage.output      || 0,
            cache_read_tokens:  msg.usage.cacheRead   || 0,
            cache_write_tokens: msg.usage.cacheWrite  || 0,
            total_tokens:       msg.usage.totalTokens || 0,
            cost_usd:           msg.usage.cost?.total || 0,
          };
        }
        toSync.push({ role: msg.role, content: content.slice(0, 4000), telegram_id, telegram_name, chat_id, is_group, group_subject, ts, ...usage });
      } catch {}
    }

    if (!toSync.length) continue;

    // Group consecutive messages by telegram_id / chat_id for efficient logging
    for (const msg of toSync) {
      const tid = msg.telegram_id || '6759764460'; // fallback to org owner
      // For group chats, use the group chat ID as the conversation bucket
      const convId = (msg.is_group && msg.chat_id) ? msg.chat_id : tid;
      const chatType = msg.is_group ? 'group' : 'direct';
      const res = await post('conversation/log', {
        org_id: ORG_ID,
        agent_id: agent.id,
        telegram_id: tid,
        telegram_name: msg.telegram_name || null,
        group_subject: msg.group_subject || null,
        chat_type: chatType,
        platform: 'telegram',
        platform_conversation_id: convId,
        role: msg.role,
        content: msg.content,
        input_tokens:       msg.input_tokens       || 0,
        output_tokens:      msg.output_tokens      || 0,
        cache_read_tokens:  msg.cache_read_tokens  || 0,
        cache_write_tokens: msg.cache_write_tokens || 0,
        total_tokens:       msg.total_tokens       || 0,
        cost_usd:           msg.cost_usd           || 0,
      });
      if (res.conversation_id || res.message_id) totalSynced++;
    }

    state[stateKey] = latestTs;
  }

  return { synced: totalSynced };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  let totalSynced = 0;
  const results = [];

  for (const agent of AGENT_FALLBACK) {
    try {
      const { synced } = await syncAgent(agent);
      results.push(`${agent.slug}: +${synced}`);
      totalSynced += synced;
    } catch (e) {
      results.push(`${agent.slug}: error (${e.message})`);
    }
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  console.log(`[sync] done — ${totalSynced} messages synced`);
  results.forEach(r => console.log(`  ${r}`));
})();
