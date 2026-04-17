#!/usr/bin/env node
/**
 * crawl-mark-sessions.js
 * Daily crawl of Fleet-Marketing sessions — extracts Mark G.'s conversation context
 * and stores a structured summary in fleet.memories + writes a markdown brief.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const readline = require('readline');

// ─── Config ─────────────────────────────────────────────────────────────────

const SESSIONS_DIR = '/home/dev-user/cbfleet-rag-marketing/.openclaw/agents/main/sessions';
const MEMORY_DIR = '/home/dev-user/cbfleet-rag-marketing/.openclaw/workspace/memory';
const ENV_FILE = '/home/dev-user/Projects/oc-fleet/.env';
const FLEET_PROXY = 'http://127.0.0.1:20000';

const ORG_ID = 'f86d92cb-db10-43ff-9ff2-d69c319d272d';
const AGENT_ID = '792ceca1-77d9-425a-85c0-c7903eeb5b13';
const LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Load .env ───────────────────────────────────────────────────────────────

function loadEnv(envPath) {
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (e) {
    console.warn(`[warn] Could not load .env from ${envPath}: ${e.message}`);
  }
}

loadEnv(ENV_FILE);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('[error] ANTHROPIC_API_KEY not found in .env');
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function readJsonlFile(filePath) {
  return new Promise((resolve) => {
    const messages = [];
    let sessionMeta = null;
    try {
      const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'session') sessionMeta = obj;
          if (obj.type === 'message' && obj.message && obj.message.role) {
            messages.push(obj);
          }
        } catch (_) {}
      });
      rl.on('close', () => resolve({ sessionMeta, messages }));
      rl.on('error', () => resolve({ sessionMeta: null, messages: [] }));
    } catch (e) {
      resolve({ sessionMeta: null, messages: [] });
    }
  });
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text)
      .join('\n');
  }
  return '';
}

function httpPost(urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = JSON.stringify(body);
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - LOOKBACK_MS);
  const dateStr = isoDate(now);

  console.log(`[crawl-mark-sessions] Starting — cutoff: ${cutoff.toISOString()}`);

  // 1. Scan session files
  let sessionFiles;
  try {
    sessionFiles = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(SESSIONS_DIR, f));
  } catch (e) {
    console.warn(`[warn] Could not read sessions dir: ${e.message}`);
    sessionFiles = [];
  }

  if (sessionFiles.length === 0) {
    console.log('[crawl-mark-sessions] No session files found. Nothing to do.');
    return;
  }

  console.log(`[crawl-mark-sessions] Found ${sessionFiles.length} session file(s)`);

  // 2. Read & filter messages from last 24h
  const recentTurns = []; // { role, text, timestamp }

  for (const filePath of sessionFiles) {
    const { messages } = await readJsonlFile(filePath);
    for (const msg of messages) {
      const ts = msg.timestamp ? new Date(msg.timestamp) : null;
      if (!ts || ts < cutoff) continue;
      const role = msg.message.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = extractText(msg.message.content);
      if (!text.trim()) continue;
      recentTurns.push({ role, text: text.trim(), timestamp: ts, file: path.basename(filePath) });
    }
  }

  // Sort by timestamp
  recentTurns.sort((a, b) => a.timestamp - b.timestamp);

  if (recentTurns.length === 0) {
    console.log('[crawl-mark-sessions] No messages found in the last 24 hours. Nothing to summarize.');
    return;
  }

  const userMsgs = recentTurns.filter(t => t.role === 'user');
  console.log(`[crawl-mark-sessions] ${recentTurns.length} total turns (${userMsgs.length} from user) in last 24h`);

  // 3. Build conversation text for Claude
  const conversationText = recentTurns
    .map(t => `[${t.role.toUpperCase()} @ ${t.timestamp.toISOString()}]\n${t.text}`)
    .join('\n\n---\n\n');

  // 4. Call claude-haiku-4-5 for structured extraction
  console.log('[crawl-mark-sessions] Calling Claude Haiku for extraction...');

  const systemPrompt = `You are an expert at analyzing sales coaching conversations. Extract structured information from Fleet-Marketing agent sessions between Mark (user) and the AI assistant.`;

  const userPrompt = `Analyze this conversation from the last 24 hours and extract exactly these 5 categories. Be concise and specific — use bullet points within each category. If nothing relevant was found for a category, write "Nothing noted."

CATEGORIES TO EXTRACT:
1. **New context routers or rule changes** — Any updates to routing logic (SD=Same Day, HT=High Ticket, NU=New User, DC=Discovery Call, etc.), new rules, or behavioral changes for the bot
2. **Tone/script rules updated** — Any changes to how the bot should speak, respond, or handle objections; new templates or scripts
3. **New company profiles worked** — Companies, industries, or ICPs that were profiled, discussed, or added to targeting
4. **Decisions locked to memory** — Important decisions, configurations, or facts that should be remembered long-term
5. **Pending items / follow-ups** — Unresolved questions, tasks Mark mentioned needing to do, or items to revisit

CONVERSATION:
${conversationText.slice(0, 40000)}`;

  let summary;
  try {
    const response = await httpPost(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      },
      {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      }
    );

    if (response.status !== 200) {
      throw new Error(`Anthropic API returned ${response.status}: ${JSON.stringify(response.body)}`);
    }

    summary = extractText(response.body.content);
  } catch (e) {
    console.error(`[error] Claude extraction failed: ${e.message}`);
    // Fall back to raw summary
    summary = `[Extraction failed — raw stats only]\n\nMessages in last 24h: ${recentTurns.length} total (${userMsgs.length} from user)\n\nSample user messages:\n${userMsgs.slice(0, 5).map(m => `- ${m.text.slice(0, 100)}`).join('\n')}`;
  }

  console.log('\n── SUMMARY ──────────────────────────────────────────────────');
  console.log(summary);
  console.log('─────────────────────────────────────────────────────────────\n');

  // 5. Store in fleet.memories
  const memoryContent = `DAILY CRAWL — ${dateStr}\n\n${summary}`;

  console.log('[crawl-mark-sessions] Storing in fleet.memories...');
  try {
    const storeResp = await httpPost(
      `${FLEET_PROXY}/fleet-api/store`,
      {
        org_id: ORG_ID,
        agent_id: AGENT_ID,
        memory_type: 'episodic',
        visibility: 'org',
        salience: 0.85,
        content: memoryContent,
      }
    );

    if (storeResp.status >= 200 && storeResp.status < 300) {
      console.log(`[crawl-mark-sessions] Memory stored ✓ (id: ${storeResp.body?.id || 'unknown'})`);
    } else {
      console.warn(`[warn] Memory store returned ${storeResp.status}: ${JSON.stringify(storeResp.body)}`);
    }
  } catch (e) {
    console.warn(`[warn] Memory store failed: ${e.message}`);
  }

  // 6. Write markdown brief
  const mdPath = path.join(MEMORY_DIR, `dm-mark-${dateStr}.md`);
  const mdContent = `# Daily Mark G. Session Brief — ${dateStr}

> Auto-generated by crawl-mark-sessions.js at ${now.toISOString()}

**Sessions scanned:** ${sessionFiles.length}  
**Messages in last 24h:** ${recentTurns.length} total (${userMsgs.length} from user)  

---

${summary}

---

_Stored in fleet.memories — org: ${ORG_ID} / agent: ${AGENT_ID}_
`;

  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(mdPath, mdContent, 'utf8');
    console.log(`[crawl-mark-sessions] Brief written to ${mdPath}`);
  } catch (e) {
    console.warn(`[warn] Could not write brief: ${e.message}`);
  }

  console.log('[crawl-mark-sessions] Done ✓');
}

main().catch(e => {
  console.error('[fatal]', e.message);
  process.exit(1);
});
