const http = require('http');
const https = require('https');
const { Client } = require('pg');
const { processConversation, embedTexts, chunkText } = require('./chunker');

// ── Conversation Summarizer ──────────────────────────────────────────────────
// ── Handoff status notification ─────────────────────────────────────────────
async function notifyHandoffUpdate(pg, handoff, status, detail) {
  const https = require('https');
  const sendTg = (botToken, chatId, text) => new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', () => resolve());
    req.setTimeout(6000, () => { req.destroy(); resolve(); });
    req.write(body); req.end();
  });

  const emoji = status === 'accepted' ? '✅' : status === 'rejected' ? '❌' : '🏁';
  const label = status === 'accepted' ? 'Accepted' : status === 'rejected' ? 'Denied' : 'Completed';

  try {
    // Get agent names + bot tokens
    const agentR = await pg.query(
      `SELECT id, name, slug, bot_token FROM fleet.agents
       WHERE id IN ($1, $2)`,
      [handoff.from_agent_id, handoff.to_agent_id]
    );
    const agentMap = {};
    for (const a of agentR.rows) agentMap[a.id] = a;
    const fromAgent = agentMap[handoff.from_agent_id];
    const toAgent   = agentMap[handoff.to_agent_id];

    const msgToUser = detail
      ? `${emoji} *Handoff ${label}*\n\nYour request to ${toAgent?.name || 'the agent'} was ${label.toLowerCase()}.\nReason: ${detail}`
      : `${emoji} *Handoff ${label}*\n\nYour request has been ${label.toLowerCase()} by ${toAgent?.name || 'the agent'}.`;

    // Notify user via from_agent bot (they know this bot)
    if (handoff.telegram_id && fromAgent?.bot_token) {
      await sendTg(fromAgent.bot_token, handoff.telegram_id, msgToUser);
    }

    // Notify originating agent via hooks/wake
    if (fromAgent?.id && handoff.from_agent_id !== handoff.to_agent_id) {
      const hookR = await pg.query(
        `SELECT gateway_port, hooks_token FROM fleet.agents WHERE id=$1`, [handoff.from_agent_id]
      );
      if (hookR.rows[0]?.hooks_token) {
        const { gateway_port, hooks_token } = hookR.rows[0];
        const http2 = require('http');
        const wakeBody = JSON.stringify({ text: `Handoff ${handoff.id.slice(0,8)} was ${label} by ${toAgent?.name || 'agent'}. Summary: ${handoff.summary?.slice(0,100)}`, mode: 'now' });
        const wreq = http2.request({ hostname: '127.0.0.1', port: gateway_port, path: '/hooks/wake', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wakeBody), 'Authorization': `Bearer ${hooks_token}` }}, () => {});
        wreq.on('error', () => {});
        wreq.write(wakeBody); wreq.end();
      }
    }
  } catch (e) {
    console.error('[handoff-notify]', e.message);
  }
}

async function summarizeConversation(pg, conversationId, totalMessages, anthropicKey) {
  if (!anthropicKey) return { skipped: 'no anthropic key' };

  // Find the last summary's to_message_id so we only summarize new messages
  const lastSummaryR = await pg.query(
    `SELECT to_message_id, message_count FROM fleet.conversation_summaries
     WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [conversationId]
  );
  const lastToMsgId = lastSummaryR.rows[0]?.to_message_id || null;

  // Fetch unsummarized messages (after last summary, up to 50)
  let msgs;
  if (lastToMsgId) {
    const r = await pg.query(
      `SELECT id, role, content, created_at FROM fleet.messages
       WHERE conversation_id = $1
       AND created_at > (SELECT created_at FROM fleet.messages WHERE id = $2)
       ORDER BY created_at ASC LIMIT 50`,
      [conversationId, lastToMsgId]
    );
    msgs = r.rows;
  } else {
    const r = await pg.query(
      `SELECT id, role, content, created_at FROM fleet.messages
       WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 50`,
      [conversationId]
    );
    msgs = r.rows;
  }

  if (msgs.length < 10) return { skipped: 'not enough new messages', count: msgs.length };

  const fromMsgId = msgs[0].id;
  const toMsgId = msgs[msgs.length - 1].id;

  // Build transcript
  const transcript = msgs.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n');

  // Call Claude Haiku for summarization
  const payload = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Summarize this conversation concisely. Focus on: what the user asked, what was resolved, key facts learned, any open items or handoffs. Be brief and factual.\n\nCONVERSATION:\n${transcript}\n\nSUMMARY:`
    }]
  });

  const summary = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          resolve(r.content?.[0]?.text || '');
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  if (!summary) return { skipped: 'empty summary from Claude' };

  // Store in fleet.conversation_summaries
  await pg.query(
    `INSERT INTO fleet.conversation_summaries
       (conversation_id, summary, from_message_id, to_message_id, message_count, model_used)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [conversationId, summary, fromMsgId, toMsgId, msgs.length, 'claude-haiku-4-5']
  );

  console.log(`[summarizer] conversation=${conversationId} messages=${msgs.length} chars=${summary.length}`);
  return { success: true, conversation_id: conversationId, messages_summarized: msgs.length, summary_length: summary.length };
}

async function notifyViaHandoff(pg, orgId, accountId, summary, nextAction) {
  if (!accountId) return;
  try {
    const r = await pg.query(
      'SELECT tb.agent_id FROM fleet.telegram_bindings tb WHERE tb.org_id=$1 AND tb.account_id=$2 LIMIT 1',
      [orgId, accountId]
    );
    if (!r.rows.length || !r.rows[0].agent_id) return;
    const toAgentId = r.rows[0].agent_id;
    await pg.query(
      "INSERT INTO fleet.handoffs (org_id, from_agent_id, to_agent_id, summary, next_action, status, user_id, visibility) VALUES ($1,$2,$3,$4,$5,'pending',$6,'org')",
      [orgId, toAgentId, toAgentId, summary, nextAction, accountId]
    );
  } catch(e) { console.error('[notifyViaHandoff]', e.message); }
}

const PORT = process.env.PORT || 20000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || OPENAI_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'Callbox Fleet <noreply@callboxinc.com>';

async function sendOTPEmail(to, otp, name) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const body = JSON.stringify({
    from: RESEND_FROM,
    to: [to],
    subject: 'Your Callbox Fleet Verification Code',
    html: `<p>Hi ${name || 'there'},</p><p>Your verification code for <strong>Callbox Fleet</strong> is:</p><h2 style="font-size:32px;letter-spacing:8px;font-family:monospace">${otp}</h2><p>This code expires in <strong>10 minutes</strong>. Do not share it.</p><p>If you did not request this, please ignore this email.</p><p>— Callbox Fleet</p>`
  });
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject); req.write(body); req.end();
  });
  if (res.statusCode === 403 || res.name === 'validation_error') throw new Error(res.message || 'Email send failed');
  return res;
}

// Local Docker PG (primary) — fallback to Supabase if LOCAL_PG_ONLY not set
const LOCAL_DB_URL = process.env.LOCAL_DATABASE_URL ||
  'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

async function getClient() {
  const pg = new Client({
    connectionString: LOCAL_DB_URL,
    ssl: LOCAL_DB_URL.includes('supabase') ? { rejectUnauthorized: false } : false
  });
  await pg.connect();
  return pg;
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  // ── REST shims ────────────────────────────────────────────────────────────
  // GET /api/sessions/stats?org_id=  →  POST /fleet-api/session/stats
  // GET /api/sessions/reports?org_id= →  POST /fleet-api/session/stats
  if (req.method === 'GET' && (req.url.startsWith('/api/sessions/stats') || req.url.startsWith('/api/sessions/reports'))) {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const org_id = urlObj.searchParams.get('org_id');
    const fwd = http.request({ hostname: '127.0.0.1', port: PORT, path: '/fleet-api/session/stats', method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, fwdRes => {
      let d = ''; fwdRes.on('data', c => d += c);
      fwdRes.on('end', () => { res.writeHead(fwdRes.statusCode, CORS); res.end(d); });
    });
    fwd.on('error', e => { res.writeHead(502, CORS); res.end(JSON.stringify({ error: e.message })); });
    fwd.write(JSON.stringify({ org_id }));
    fwd.end();
    return;
  }

  const fn = req.url.replace('/fleet-api/', '');
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    let p = {};
    try { p = JSON.parse(body || '{}'); } catch (e) {}

    const pg = await getClient().catch(e => {
      res.writeHead(500, CORS);
      res.end(JSON.stringify({ error: 'DB connection failed: ' + e.message }));
      return null;
    });
    if (!pg) return;

    try {
      let result;

      // ── Memory ──────────────────────────────────────────────────────────
      if (fn === 'store') {
        const r = await pg.query(
          `INSERT INTO fleet.memories (org_id, agent_id, content, memory_type, visibility, salience)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, content, created_at`,
          [p.org_id, p.agent_id, p.content, p.memory_type || 'long_term', p.visibility || 'org', p.salience || 0.7]
        );
        result = r.rows[0];

      } else if (fn === 'retrieve') {
        const r = await pg.query(
          `SELECT id, agent_id, content, memory_type, salience, created_at
           FROM fleet.memories
           WHERE org_id = $1
           ORDER BY created_at DESC
           LIMIT 10`,
          [p.org_id]
        );
        result = { memories: r.rows };

      // ── Handoffs ─────────────────────────────────────────────────────────
      } else if (fn === 'handoff') {
        if (p.action === 'create') {
          // Resolve user_id from telegram_id if provided
          let user_id = p.user_id || null;
          let department = p.department || null;
          if (!user_id && p.telegram_id) {
            const u = await pg.query(
              `SELECT tb.account_id, a.department FROM fleet.telegram_bindings tb
               JOIN fleet.accounts a ON a.id = tb.account_id
               WHERE tb.telegram_id = $1`, [p.telegram_id]
            );
            if (u.rows.length) { user_id = u.rows[0].account_id; department = department || u.rows[0].department; }
          }
          const target_type = p.target_type || (user_id ? 'user' : 'org');
          const visibility = p.visibility || target_type;
          const r = await pg.query(
            `INSERT INTO fleet.handoffs (org_id, from_agent_id, to_agent_id, summary, next_action, status, user_id, department, visibility, target_type)
             VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)
             RETURNING id, status, created_at`,
            [p.org_id, p.from_agent_id, p.to_agent_id, p.summary, p.next_action || null, user_id, department, visibility, target_type]
          );
          result = { handoff: r.rows[0] };

        } else if (p.action === 'list') {
          // Scoped: by agent + user_id (only this user's handoffs) or dept
          let user_id = p.user_id || null;
          if (!user_id && p.telegram_id) {
            const u = await pg.query(
              `SELECT account_id FROM fleet.telegram_bindings WHERE telegram_id=$1`, [p.telegram_id]
            );
            if (u.rows.length) user_id = u.rows[0].account_id;
          }
          const r = await pg.query(
            `SELECT h.id, h.from_agent_id, h.summary, h.next_action, h.status, h.created_at,
                    h.user_id, h.department, h.visibility,
                    a.name as from_agent_name
             FROM fleet.handoffs h
             JOIN fleet.agents a ON a.id = h.from_agent_id
             WHERE h.to_agent_id = $1 AND h.status = 'pending'
               AND (h.visibility = 'org'
                    OR (h.visibility = 'user' AND h.user_id = $2)
                    OR (h.visibility = 'department' AND h.department = (
                        SELECT department FROM fleet.accounts WHERE id = $2
                    )))
             ORDER BY h.created_at DESC`,
            [p.agent_id, user_id]
          );
          result = { handoffs: r.rows };

        } else if (p.action === 'list-all') {
          // Manager: org-wide, but respect visibility scoping per requesting user
          let user_id = p.user_id || null;
          if (!user_id && p.telegram_id) {
            const u = await pg.query(
              `SELECT tb.account_id, a.role FROM fleet.telegram_bindings tb
               JOIN fleet.accounts a ON a.id = tb.account_id WHERE tb.telegram_id=$1`, [p.telegram_id]
            );
            if (u.rows.length) {
              user_id = u.rows[0].account_id;
              // Admins see all; others see only their scope
              if (u.rows[0].role === 'admin') user_id = null;
            }
          }
          const r = await pg.query(
            `SELECT h.id, h.from_agent_id, h.to_agent_id, h.summary, h.next_action,
                    h.status, h.created_at, h.user_id, h.department, h.visibility,
                    a1.name as from_agent_name, a2.name as to_agent_name,
                    acc.name as user_name, acc.email as user_email
             FROM fleet.handoffs h
             JOIN fleet.agents a1 ON a1.id = h.from_agent_id
             JOIN fleet.agents a2 ON a2.id = h.to_agent_id
             LEFT JOIN fleet.accounts acc ON acc.id = h.user_id
             WHERE h.org_id = $1
               AND ($2::uuid IS NULL OR h.visibility = 'org'
                    OR h.user_id = $2
                    OR h.department = (SELECT department FROM fleet.accounts WHERE id = $2))
             ORDER BY h.created_at DESC LIMIT 50`,
            [p.org_id, user_id]
          );
          result = { handoffs: r.rows };

        } else if (p.action === 'accept') {
          const r = await pg.query(
            `UPDATE fleet.handoffs SET status = 'accepted', accepted_at = now(), updated_at = now()
             WHERE id = $1 RETURNING id, status, accepted_at, from_agent_id, to_agent_id, user_id, telegram_id, summary`,
            [p.handoff_id]
          );
          result = { handoff: r.rows[0] };
          // Fire notification back (async)
          if (r.rows[0]) notifyHandoffUpdate(pg, r.rows[0], 'accepted', null).catch(() => {});

        } else if (p.action === 'deny' || p.action === 'reject') {
          // p: { handoff_id, reason? }
          const r = await pg.query(
            `UPDATE fleet.handoffs
             SET status = 'rejected', updated_at = now(),
                 current_state = current_state || $2::jsonb
             WHERE id = $1
             RETURNING id, status, updated_at, from_agent_id, to_agent_id, user_id, telegram_id, summary`,
            [p.handoff_id, JSON.stringify({ rejected_reason: p.reason || 'Denied by agent', rejected_at: new Date().toISOString() })]
          );
          result = { handoff: r.rows[0] };
          if (r.rows[0]) notifyHandoffUpdate(pg, r.rows[0], 'rejected', p.reason || 'Denied by agent').catch(() => {});

        } else if (p.action === 'complete') {
          // p: { handoff_id, summary? }
          const r = await pg.query(
            `UPDATE fleet.handoffs
             SET status = 'completed', completed_at = now(), updated_at = now(),
                 current_state = current_state || $2::jsonb
             WHERE id = $1
             RETURNING id, status, completed_at, from_agent_id, to_agent_id, user_id, telegram_id, summary`,
            [p.handoff_id, JSON.stringify({ completion_summary: p.summary || '' })]
          );
          result = { handoff: r.rows[0] };
          if (r.rows[0]) notifyHandoffUpdate(pg, r.rows[0], 'completed', p.summary || null).catch(() => {});
        }

      // ── Pairing: check if telegram user is already bound ─────────────────
      } else if (fn === 'pairing/check') {
        // p: { telegram_id, org_id, agent_id?, message?, message_id? }
        const r = await pg.query(
          `SELECT tb.telegram_id, tb.telegram_name, tb.bound_at,
                  a.email, a.name, a.role, a.department, a.permissions, a.is_active
           FROM fleet.telegram_bindings tb
           JOIN fleet.accounts a ON a.id = tb.account_id
           WHERE tb.telegram_id = $1 AND tb.org_id = $2`,
          [p.telegram_id, p.org_id]
        );
        result = r.rows.length > 0
          ? { bound: true, user: r.rows[0] }
          : { bound: false };

        // Auto-log conversation if agent_id + message provided (fire and forget)
        if (p.agent_id && p.message && p.telegram_id) {
          (async () => {
            try {
              // Upsert conversation row
              const convR = await pg.query(
                `INSERT INTO fleet.conversations
                   (org_id, agent_id, platform, platform_conversation_id, status, title, chat_type, channel)
                 VALUES ($1,$2,'telegram',$3,'active',$4,'direct','telegram')
                 ON CONFLICT (org_id, platform, platform_conversation_id, agent_id)
                 DO UPDATE SET last_message_at=now() RETURNING id`,
                [p.org_id, p.agent_id, p.telegram_id,
                 (r.rows[0]?.name || p.telegram_id) + ' / ' + p.agent_id.slice(0,8)]
              );
              const conv_id = convR.rows[0].id;
              // Ensure active session exists and link conversation to it
              const pairSessR = await pg.query(
                `SELECT id FROM fleet.sessions WHERE agent_id=$1 AND platform_chat_id=$2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
                [p.agent_id, p.telegram_id]
              );
              let pairSessionId;
              if (pairSessR.rows.length > 0) {
                pairSessionId = pairSessR.rows[0].id;
              } else {
                const pairNewSess = await pg.query(
                  `INSERT INTO fleet.sessions (org_id, agent_id, platform_chat_id, chat_type)
                   VALUES ($1,$2,$3,'direct') RETURNING id`,
                  [p.org_id, p.agent_id, p.telegram_id]
                );
                pairSessionId = pairNewSess.rows[0].id;
              }
              await pg.query(
                `UPDATE fleet.conversations SET session_id=$1 WHERE id=$2 AND session_id IS NULL`,
                [pairSessionId, conv_id]
              );
              // Log inbound message
              await pg.query(
                `INSERT INTO fleet.messages
                   (conversation_id, role, content, platform_message_id, user_id, agent_id)
                 VALUES ($1,'user',$2,$3,
                   (SELECT account_id FROM fleet.telegram_bindings WHERE telegram_id=$4 AND org_id=$5 LIMIT 1),
                   $6)`,
                [conv_id, p.message, p.message_id||null, p.telegram_id, p.org_id, p.agent_id]
              );
              // Trigger chunker check
              const cnt = await pg.query('SELECT COUNT(*) FROM fleet.messages WHERE conversation_id=$1',[conv_id]);
              const msgCount = parseInt(cnt.rows[0].count,10);
              if (msgCount % 5 === 0) processConversation(conv_id, LOCAL_DB_URL, ANTHROPIC_KEY, GEMINI_KEY).catch(()=>{});
              if (msgCount > 0 && msgCount % 50 === 0) summarizeConversation(pg, conv_id, msgCount, ANTHROPIC_KEY).catch(()=>{});
            } catch(e) { console.error('[auto-log]', e.message); }
          })();
        }

      // ── Pairing: verify email and bind telegram user ──────────────────────
      // ── OTP ───────────────────────────────────────────────────────────
      } else if (fn === 'pairing/otp/send') {
        // p: { org_id, telegram_id, telegram_name, email }
        // 1. Check account exists
        const acct = await pg.query(
          `SELECT id, name, email, is_active FROM fleet.accounts WHERE org_id=$1 AND LOWER(email)=LOWER($2)`,
          [p.org_id, p.email]
        );
        if (!acct.rows.length) { result = { success: false, reason: 'email_not_found' }; }
        else if (!acct.rows[0].is_active) { result = { success: false, reason: 'account_inactive' }; }
        else {
          const otp = String(Math.floor(100000 + Math.random() * 900000));
          const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
          await pg.query(
            `INSERT INTO fleet.otp_verifications (org_id, telegram_id, email, otp_code, expires_at, attempts, verified)
             VALUES ($1,$2,$3,$4,$5,0,false)
             ON CONFLICT (telegram_id, email) DO UPDATE SET otp_code=$4, expires_at=$5, attempts=0, verified=false`,
            [p.org_id, p.telegram_id, p.email, otp, expires]
          );
          try {
            await sendOTPEmail(acct.rows[0].email, otp, acct.rows[0].name);
            result = { success: true, message: `OTP sent to ${p.email}` };
          } catch (e) {
            // Fallback: return OTP in response for testing (remove in production)
            console.error('[OTP] Email failed:', e.message);
            result = { success: true, message: `OTP sent (email failed: ${e.message})`, _dev_otp: otp };
          }
        }

      } else if (fn === 'pairing/otp/verify') {
        // p: { org_id, telegram_id, telegram_name, email, otp_code }
        const row = await pg.query(
          `SELECT * FROM fleet.otp_verifications
           WHERE telegram_id=$1 AND LOWER(email)=LOWER($2) AND verified=false AND expires_at > now()
           ORDER BY created_at DESC LIMIT 1`,
          [p.telegram_id, p.email]
        );
        if (!row.rows.length) {
          result = { success: false, reason: 'otp_expired_or_not_found' };
        } else if (row.rows[0].attempts >= 3) {
          result = { success: false, reason: 'too_many_attempts' };
        } else if (row.rows[0].otp_code !== String(p.otp_code).trim()) {
          await pg.query(`UPDATE fleet.otp_verifications SET attempts=attempts+1 WHERE id=$1`, [row.rows[0].id]);
          const remaining = 3 - (row.rows[0].attempts + 1);
          result = { success: false, reason: 'wrong_otp', attempts_remaining: remaining };
        } else {
          // OTP correct — mark verified and bind
          await pg.query(`UPDATE fleet.otp_verifications SET verified=true WHERE id=$1`, [row.rows[0].id]);
          // Now bind the account
          const acct = await pg.query(
            `SELECT id, email, name, role, department, permissions, is_active FROM fleet.accounts
             WHERE org_id=$1 AND LOWER(email)=LOWER($2)`,
            [p.org_id, p.email]
          );
          const account = acct.rows[0];
          await pg.query(
            `INSERT INTO fleet.telegram_bindings (org_id, telegram_id, telegram_username, telegram_name, account_id, agent_id)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (org_id, telegram_id) DO UPDATE SET
               telegram_name=EXCLUDED.telegram_name, account_id=EXCLUDED.account_id, last_seen_at=now()`,
            [p.org_id, p.telegram_id, p.telegram_username||null, p.telegram_name||null, account.id, p.agent_id||null]
          );
          result = {
            success: true,
            user: { email: account.email, name: account.name, role: account.role, department: account.department, permissions: account.permissions }
          };
        }

      } else if (fn === 'pairing/bind') {
        // p: { telegram_id, telegram_username, telegram_name, email, org_id, agent_id }
        // 1. Lookup account by email
        const acct = await pg.query(
          `SELECT id, email, name, role, department, permissions, is_active
           FROM fleet.accounts
           WHERE org_id = $1 AND LOWER(email) = LOWER($2)`,
          [p.org_id, p.email]
        );

        if (acct.rows.length === 0) {
          result = { success: false, reason: 'email_not_found' };
        } else if (!acct.rows[0].is_active) {
          result = { success: false, reason: 'account_inactive' };
        } else {
          const account = acct.rows[0];
          // 2. Insert or update binding
          const bind = await pg.query(
            `INSERT INTO fleet.telegram_bindings
               (org_id, telegram_id, telegram_username, telegram_name, account_id, agent_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (org_id, telegram_id)
             DO UPDATE SET
               telegram_username = EXCLUDED.telegram_username,
               telegram_name = EXCLUDED.telegram_name,
               account_id = EXCLUDED.account_id,
               last_seen_at = now()
             RETURNING id, bound_at`,
            [p.org_id, p.telegram_id, p.telegram_username || null, p.telegram_name || null, account.id, p.agent_id || null]
          );
          result = {
            success: true,
            user: {
              email: account.email,
              name: account.name,
              role: account.role,
              department: account.department,
              permissions: account.permissions
            },
            binding: bind.rows[0]
          };
        }

      // ── Pairing: update last_seen ─────────────────────────────────────────
      } else if (fn === 'pairing/touch') {
        await pg.query(
          `UPDATE fleet.telegram_bindings SET last_seen_at = now()
           WHERE telegram_id = $1 AND org_id = $2`,
          [p.telegram_id, p.org_id]
        );
        result = { ok: true };

      // ── Accounts: list ────────────────────────────────────────────────────
      // ── Agent Config ─────────────────────────────────────────────────────
      } else if (fn === 'agent/config') {
        // Fetch global config (agent_id IS NULL) + agent-specific config, merge them
        const [globalR, agentR] = await Promise.all([
          pg.query(
            `SELECT system_prompt, skill_map, behaviors FROM fleet.agent_configs
             WHERE agent_id IS NULL AND is_active = true ORDER BY version DESC LIMIT 1`
          ),
          pg.query(
            `SELECT ac.system_prompt, ac.skill_map, ac.behaviors, ac.version, ac.updated_at, a.name, a.slug
             FROM fleet.agent_configs ac
             JOIN fleet.agents a ON a.id = ac.agent_id
             WHERE ac.agent_id = $1 AND ac.is_active = true
             ORDER BY ac.version DESC LIMIT 1`,
            [p.agent_id]
          ),
        ]);
        if (agentR.rows.length === 0) {
          result = { error: 'No config found for agent' };
        } else {
          const global = globalR.rows[0] || {};
          const agent = agentR.rows[0];
          // Merge: global system_prompt prepended to agent-specific, skill_maps merged
          result = {
            config: {
              ...agent,
              system_prompt: (global.system_prompt ? global.system_prompt + '\n\n---\n\n' : '') + agent.system_prompt,
              skill_map: { ...(global.skill_map || {}), ...(agent.skill_map || {}) },
              behaviors: { ...(global.behaviors || {}), ...(agent.behaviors || {}) },
            }
          };
        }

      } else if (fn === 'agent/config/update') {
        const cur = await pg.query(
          `SELECT version FROM fleet.agent_configs WHERE agent_id=$1 AND is_active=true ORDER BY version DESC LIMIT 1`,
          [p.agent_id]
        );
        const nextVersion = (cur.rows[0]?.version || 0) + 1;
        await pg.query(`UPDATE fleet.agent_configs SET is_active=false WHERE agent_id=$1 AND is_active=true`, [p.agent_id]);
        const orgR = await pg.query(`SELECT org_id FROM fleet.agents WHERE id=$1`, [p.agent_id]);
        await pg.query(
          `INSERT INTO fleet.agent_configs (agent_id, org_id, version, system_prompt, skill_map, behaviors)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [p.agent_id, orgR.rows[0].org_id, nextVersion,
           p.system_prompt, p.skill_map ? JSON.stringify(p.skill_map) : '{}',
           p.behaviors ? JSON.stringify(p.behaviors) : '{}']
        );
        result = { success: true, version: nextVersion };

      // ── Skills ───────────────────────────────────────────────────────────
      } else if (fn === 'skills/resolve') {
        // p: { org_id, account_id } or { org_id, telegram_id }
        let account_id = p.account_id;
        if (!account_id && p.telegram_id) {
          const r = await pg.query(
            `SELECT account_id FROM fleet.telegram_bindings WHERE telegram_id = $1`,
            [p.telegram_id]
          );
          account_id = r.rows[0]?.account_id || null;
        }
        if (!account_id) { result = { skills: [] }; }
        else {
          const r = await pg.query(
            `SELECT slug, name, description, category, source, can_use, can_configure
             FROM fleet.resolve_skills($1, $2)`,
            [p.org_id, account_id]
          );
          result = { skills: r.rows };
        }

      } else if (fn === 'skills/list') {
        // All skills, or filtered by agent_id if provided
        if (p.agent_id) {
          const r = await pg.query(
            `SELECT s.id, s.slug, s.name, s.description, s.category, s.is_active,
                    s.api_endpoint, s.api_method, s.instructions
             FROM fleet.skills s
             JOIN fleet.agent_skill_assignments asa ON asa.skill_id = s.id
             WHERE asa.agent_id = $1 AND asa.enabled = true AND s.is_active = true
             ORDER BY s.category, s.slug`,
            [p.agent_id]
          );
          result = { skills: r.rows };
        } else {
          const r = await pg.query(
            `SELECT id, slug, name, description, category, is_active FROM fleet.skills ORDER BY category, slug`
          );
          result = { skills: r.rows };
        }

      } else if (fn === 'skills/override') {
        // p: { org_id, account_id, skill_slug, override_type (grant|revoke), reason?, granted_by_telegram_id? }
        const skillR = await pg.query(`SELECT id FROM fleet.skills WHERE slug = $1`, [p.skill_slug]);
        if (!skillR.rows.length) { result = { error: 'Skill not found' }; }
        else {
          await pg.query(
            `INSERT INTO fleet.user_skill_overrides (org_id, account_id, skill_id, override_type, reason)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (org_id, account_id, skill_id)
             DO UPDATE SET override_type = EXCLUDED.override_type, reason = EXCLUDED.reason`,
            [p.org_id, p.account_id, skillR.rows[0].id, p.override_type, p.reason || null]
          );
          result = { success: true, slug: p.skill_slug, override_type: p.override_type };
        }

      } else if (fn === 'accounts/list') {
        const r = await pg.query(
          `SELECT id, email, name, role, department, is_active, created_at
           FROM fleet.accounts WHERE org_id = $1 ORDER BY name`,
          [p.org_id]
        );
        result = { accounts: r.rows };

      // ── Conversation: log a message turn ─────────────────────────────────
      } else if (fn === 'conversation/log') {
        // Validate required fields
        if (!p.org_id || !p.agent_id || !p.platform_conversation_id || !p.role || !p.content) {
          result = { error: 'Missing required fields: org_id, agent_id, platform_conversation_id, role, content' };
          await pg.end(); res.writeHead(400, CORS); res.end(JSON.stringify(result)); return;
        }
        // 1. Upsert conversation
        const agentSlugR = await pg.query(
          `SELECT slug FROM fleet.agents WHERE id = $1`,
          [p.agent_id]
        );
        const agentSlug = agentSlugR.rows[0]?.slug || p.agent_id;
        const convTitle = `${p.telegram_name} @ ${agentSlug}`;
        const convR = await pg.query(
          `INSERT INTO fleet.conversations (org_id, agent_id, platform, platform_conversation_id, status, title, chat_type, channel)
           VALUES ($1, $2, 'telegram', $3, 'active', $4, $5, 'telegram')
           ON CONFLICT (org_id, platform, platform_conversation_id, agent_id)
           DO UPDATE SET last_message_at = now()
           RETURNING id`,
          [p.org_id, p.agent_id, p.platform_conversation_id, convTitle, p.chat_type || (String(p.platform_conversation_id).startsWith('-') ? 'group' : 'direct')]
        );
        const conversation_id = convR.rows[0].id;

        // 1b. Ensure active session exists and link conversation to it
        const logSessR = await pg.query(
          `SELECT id FROM fleet.sessions WHERE agent_id=$1 AND platform_chat_id=$2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
          [p.agent_id, p.platform_conversation_id]
        );
        let logSessionId;
        if (logSessR.rows.length > 0) {
          logSessionId = logSessR.rows[0].id;
        } else {
          const logNewSess = await pg.query(
            `INSERT INTO fleet.sessions (org_id, agent_id, platform_chat_id, chat_type)
             VALUES ($1,$2,$3,$4) RETURNING id`,
            [p.org_id, p.agent_id, p.platform_conversation_id, p.chat_type || (String(p.platform_conversation_id).startsWith('-') ? 'group' : 'direct')]
          );
          logSessionId = logNewSess.rows[0].id;
        }
        await pg.query(
          `UPDATE fleet.conversations SET session_id=$1 WHERE id=$2 AND session_id IS NULL`,
          [logSessionId, conversation_id]
        );

        // 2. Lookup user_id from telegram_bindings (may be null)
        const bindR = await pg.query(
          `SELECT account_id FROM fleet.telegram_bindings WHERE telegram_id = $1`,
          [p.telegram_id]
        );
        const user_id = bindR.rows[0]?.account_id || null;

        // 3. Insert message
        const msgR = await pg.query(
          `INSERT INTO fleet.messages (conversation_id, role, content, platform_message_id, user_id, agent_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, created_at`,
          [conversation_id, p.role, p.content, p.platform_message_id || null, user_id, p.agent_id]
        );
        result = {
          conversation_id,
          message_id: msgR.rows[0].id,
          created_at: msgR.rows[0].created_at
        };

        // Trigger chunker every 5 messages (fire and forget)
        const cntR = await pg.query(
          `SELECT COUNT(*) FROM fleet.messages WHERE conversation_id = $1`,
          [conversation_id]
        );
        const msgCount = parseInt(cntR.rows[0].count, 10);
        if (msgCount % 5 === 0) {
          processConversation(conversation_id, LOCAL_DB_URL, ANTHROPIC_KEY, GEMINI_KEY)
            .then(r => console.log('[chunker] done:', r))
            .catch(e => console.error('[chunker] error:', e.message));
        }
        // Trigger conversation summarization every 50 messages (fire and forget)
        if (msgCount > 0 && msgCount % 50 === 0) {
          summarizeConversation(pg, conversation_id, msgCount, ANTHROPIC_KEY)
            .then(r => console.log('[summarizer] done:', r))
            .catch(e => console.error('[summarizer] error:', e.message));
        }

      // ── Conversation: load history ────────────────────────────────────────
      // ── Google Workspace OAuth proxy ───────────────────────────────
      } else if (fn.startsWith('google/')) {
        // Routes: google/token, google/auth/request, google/auth/status, google/session/destroy, google/sessions
        // Proxies to google-auth service at port 19001
        const GAUTH = 'http://127.0.0.1:19001';
        const route = fn.replace('google/', '/');
        const method = ['google/token','google/sessions','google/auth/status'].includes(fn) ? 'GET' : 'POST';
        const fetchUrl = method === 'GET'
          ? `${GAUTH}${route}${p.email ? '?email='+encodeURIComponent(p.email) : ''}${p.state ? '&state='+p.state : ''}`
          : `${GAUTH}${route}`;
        const fetchOpts = { method, headers: { 'Content-Type': 'application/json' } };
        if (method === 'POST') fetchOpts.body = JSON.stringify(p);
        const gRes = await fetch(fetchUrl, fetchOpts);
        result = await gRes.json();

      // ── Memory Dedup ─────────────────────────────────────────
      } else if (fn === 'memory/dedup-scan') {
        // p: { org_id, threshold_auto?, threshold_review?, limit?, memory_type? }
        // Scans for duplicate memories and auto-merges high-confidence, queues medium
        const threshAuto   = p.threshold_auto   || 0.92;
        const threshReview = p.threshold_review || 0.85;
        const limit        = p.limit || 200;
        const memType      = p.memory_type || null;

        // Fetch memories with embeddings
        const mems = await pg.query(
          `SELECT m.id, m.content, m.salience, m.memory_type, m.access_count,
                  e.embedding
           FROM fleet.memories m
           JOIN fleet.memory_embeddings e ON e.memory_id = m.id
           WHERE m.org_id = $1 AND m.deleted_at IS NULL
             AND ($2::text IS NULL OR m.memory_type = $2)
           ORDER BY m.created_at DESC LIMIT $3`,
          [p.org_id, memType, limit]
        );

        let auto_merged = 0, queued = 0, already_queued = 0;
        const groups = [];

        // Compare all pairs via pgvector cosine similarity
        const pairs = await pg.query(
          `SELECT a.id as id_a, b.id as id_b,
                  LEFT(a.content, 100) as preview_a,
                  LEFT(b.content, 100) as preview_b,
                  a.salience as sal_a, b.salience as sal_b,
                  a.memory_type,
                  1 - (ea.embedding <=> eb.embedding) as similarity
           FROM fleet.memories a
           JOIN fleet.memories b ON b.id > a.id
           JOIN fleet.memory_embeddings ea ON ea.memory_id = a.id
           JOIN fleet.memory_embeddings eb ON eb.memory_id = b.id
           WHERE a.org_id = $1 AND b.org_id = $1
             AND a.deleted_at IS NULL AND b.deleted_at IS NULL
             AND ($2::text IS NULL OR a.memory_type = $2)
             AND 1 - (ea.embedding <=> eb.embedding) >= $3
           ORDER BY similarity DESC
           LIMIT $4`,
          [p.org_id, memType, threshReview, limit]
        );

        for (const pair of pairs.rows) {
          const sim = parseFloat(pair.similarity);
          // Skip if either memory already deleted during this scan
          if (sim >= threshAuto) {
            // Auto-merge: keep higher salience
            const winnerId = pair.sal_a >= pair.sal_b ? pair.id_a : pair.id_b;
            const loserId  = winnerId === pair.id_a ? pair.id_b : pair.id_a;
            await pg.query(
              `UPDATE fleet.memories SET deleted_at = now() WHERE id = $1`,
              [loserId]
            );
            await pg.query(
              `UPDATE fleet.memories SET salience = LEAST(salience + 0.05, 1.0), access_count = access_count + 1 WHERE id = $1`,
              [winnerId]
            );
            await pg.query(
              `INSERT INTO fleet.memory_dedup_queue (org_id, memory_id_a, memory_id_b, similarity, status, winner_id, resolved_at, resolved_by)
               VALUES ($1,$2,$3,$4,'auto_merged',$5,now(),'system')
               ON CONFLICT DO NOTHING`,
              [p.org_id, pair.id_a, pair.id_b, sim, winnerId]
            );
            auto_merged++;
          } else {
            // Queue for manual review
            const inserted = await pg.query(
              `INSERT INTO fleet.memory_dedup_queue (org_id, memory_id_a, memory_id_b, similarity)
               VALUES ($1,$2,$3,$4)
               ON CONFLICT DO NOTHING
               RETURNING id`,
              [p.org_id, pair.id_a, pair.id_b, sim]
            );
            if (inserted.rowCount > 0) {
              queued++;
              groups.push({ id_a: pair.id_a, id_b: pair.id_b, similarity: sim, preview_a: pair.preview_a, preview_b: pair.preview_b, memory_type: pair.memory_type });
            } else {
              already_queued++;
            }
          }
        }
        result = { success: true, auto_merged, queued, already_queued, review_groups: groups };

      } else if (fn === 'memory/dedup-merge') {
        // p: { queue_id, winner_id, org_id } — approve a queued dedup pair
        const q = await pg.query(
          `SELECT * FROM fleet.memory_dedup_queue WHERE id=$1 AND org_id=$2 AND status='pending'`,
          [p.queue_id, p.org_id]
        );
        if (!q.rows.length) { result = { error: 'Queue item not found or already resolved' }; }
        else {
          const item = q.rows[0];
          const loserId = p.winner_id === item.memory_id_a ? item.memory_id_b : item.memory_id_a;
          await pg.query(`UPDATE fleet.memories SET deleted_at=now() WHERE id=$1`, [loserId]);
          await pg.query(`UPDATE fleet.memories SET salience=LEAST(salience+0.05,1.0), access_count=access_count+1 WHERE id=$1`, [p.winner_id]);
          await pg.query(
            `UPDATE fleet.memory_dedup_queue SET status='approved', winner_id=$1, resolved_at=now(), resolved_by='user' WHERE id=$2`,
            [p.winner_id, p.queue_id]
          );
          result = { success: true, merged: loserId, kept: p.winner_id };
        }

      } else if (fn === 'memory/dedup-skip') {
        // p: { queue_id, org_id } — skip a queued pair (not duplicates)
        await pg.query(
          `UPDATE fleet.memory_dedup_queue SET status='skipped', resolved_at=now(), resolved_by='user' WHERE id=$1 AND org_id=$2`,
          [p.queue_id, p.org_id]
        );
        result = { success: true };

      } else if (fn === 'memory/dedup-queue') {
        // p: { org_id, status? } — list pending dedup queue items with previews
        const status = p.status || 'pending';
        const r = await pg.query(
          `SELECT q.id, q.similarity, q.status, q.created_at,
                  a.id as id_a, LEFT(a.content,150) as preview_a, a.salience as sal_a, a.memory_type as type_a,
                  b.id as id_b, LEFT(b.content,150) as preview_b, b.salience as sal_b
           FROM fleet.memory_dedup_queue q
           JOIN fleet.memories a ON a.id = q.memory_id_a
           JOIN fleet.memories b ON b.id = q.memory_id_b
           WHERE q.org_id = $1 AND q.status = $2
           ORDER BY q.similarity DESC`,
          [p.org_id, status]
        );
        result = { queue: r.rows, total: r.rowCount };

      } else if (fn === 'conversation/summarize') {
        // p: { conversation_id, org_id } — manually trigger summarization
        if (!p.conversation_id) {
          result = { error: 'Required: conversation_id' };
        } else {
          const cntR = await pg.query('SELECT COUNT(*) FROM fleet.messages WHERE conversation_id=$1', [p.conversation_id]);
          const cnt = parseInt(cntR.rows[0].count, 10);
          result = await summarizeConversation(pg, p.conversation_id, cnt, ANTHROPIC_KEY);
        }

      } else if (fn === 'conversation/summaries') {
        // p: { conversation_id } — retrieve all summaries for a conversation
        if (!p.conversation_id) {
          result = { error: 'Required: conversation_id' };
        } else {
          const r = await pg.query(
            `SELECT id, summary, message_count, model_used, created_at
             FROM fleet.conversation_summaries
             WHERE conversation_id = $1
             ORDER BY created_at ASC`,
            [p.conversation_id]
          );
          result = { summaries: r.rows, total: r.rowCount };
        }

      } else if (fn === 'conversation/history') {
        // p: { session_id?, conversation_id?, telegram_id?, agent_id?, org_id, limit? }
        const limit = p.limit || 100;
        let whereClause, params;
        if (p.session_id) {
          whereClause = "c.session_id = $1";
          params = [p.session_id, limit];
        } else if (p.conversation_id) {
          whereClause = "m.conversation_id = $1";
          params = [p.conversation_id, limit];
        } else if (p.telegram_id) {
          // legacy: lookup by telegram_id + agent_id
          const convR = await pg.query(
            `SELECT id FROM fleet.conversations
             WHERE org_id = $1 AND agent_id = $2 AND platform = 'telegram' AND platform_conversation_id = $3
             ORDER BY created_at DESC LIMIT 1`,
            [p.org_id, p.agent_id, p.telegram_id]
          );
          if (convR.rows.length === 0) {
            result = { conversation_id: null, messages: [] };
          } else {
            const conversation_id = convR.rows[0].id;
            const msgR = await pg.query(
              `SELECT role, content, created_at FROM fleet.messages
               WHERE conversation_id = $1
               ORDER BY created_at DESC LIMIT $2`,
              [conversation_id, limit]
            );
            result = { conversation_id, messages: msgR.rows };
          }
        } else {
          result = { error: "session_id, conversation_id, or telegram_id required" };
        }
        if (!result) {
          const r = await pg.query(
            `SELECT m.id, m.role, m.content, m.created_at, m.platform_message_id,
                    a.name AS account_name
             FROM fleet.messages m
             JOIN fleet.conversations c ON c.id = m.conversation_id
             LEFT JOIN fleet.telegram_bindings tb ON tb.telegram_id = c.platform_conversation_id AND tb.org_id = c.org_id
             LEFT JOIN fleet.accounts a ON a.id = tb.account_id
             WHERE ${whereClause}
             ORDER BY m.created_at ASC LIMIT $${params.length}`,
            params
          );
          result = { messages: r.rows };
        }

      // ── Search: vector similarity search ─────────────────────────────────
      } else if (fn === 'search') {
        // p: { org_id, query_embedding, limit?, agent_id? }
        const limit = p.limit || 10;
        const agentId = p.agent_id || null;
        const embeddingStr = '[' + p.query_embedding.join(',') + ']';
        const r = await pg.query(
          `SELECT * FROM fleet.search_memories_scored($1, $2::vector, $3, NULL, $4, 0.35, 0.25, 0.25, 0.15)`,
          [p.org_id, embeddingStr, agentId, limit]
        );
        result = { results: r.rows };

      // ── Search: embed text then search ───────────────────────────────────
      } else if (fn === 'search/embed') {
        // p: { text, org_id, agent_id?, limit?, memory_types? }
        const limit = p.limit || 10;
        const agentId = p.agent_id || null;
        const memoryTypes = p.memory_types || null; // e.g. ['knowledge'] to filter type
        const [embedding] = await embedTexts([p.text], GEMINI_KEY);
        const embeddingStr = '[' + embedding.join(',') + ']';
        const r = await pg.query(
          `SELECT * FROM fleet.search_memories_scored($1, $2::vector, $3, $4, $5::text[], 0.35, 0.25, 0.25, 0.15)`,
          [p.org_id, embeddingStr, limit, agentId, memoryTypes]
        );
        result = { results: r.rows };

      // ── Skill Callbacks ──────────────────────────────────────────────────
      } else if (fn === 'skill/callbacks') {
        // p: { org_id, slug? } — list callbacks for a skill or all
        const r = await pg.query(
          `SELECT sc.id, sc.name, sc.endpoint, sc.method, sc.auth_type, sc.headers,
                  sc.timeout_ms, sc.retry_count, sc.is_active, sc.environment,
                  sc.transform_request, sc.transform_response,
                  s.slug, s.name as skill_name
           FROM fleet.skill_callbacks sc
           JOIN fleet.skills s ON s.id = sc.skill_id
           WHERE sc.org_id = $1 ${p.slug ? 'AND s.slug = $2' : ''}
           ORDER BY s.slug, sc.name`,
          p.slug ? [p.org_id, p.slug] : [p.org_id]
        );
        result = { callbacks: r.rows };

      } else if (fn === 'skill/callback/upsert') {
        // p: { org_id, slug, name, endpoint, method, headers, auth_type, auth_secret, timeout_ms, is_active, environment }
        const skillR = await pg.query(`SELECT id FROM fleet.skills WHERE slug=$1`, [p.slug]);
        if (!skillR.rows.length) { result = { error: 'Skill not found' }; }
        else {
          await pg.query(
            `INSERT INTO fleet.skill_callbacks (skill_id, org_id, name, endpoint, method, headers, auth_type, auth_secret, timeout_ms, retry_count, is_active, environment)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (skill_id, org_id, name, environment)
             DO UPDATE SET endpoint=EXCLUDED.endpoint, method=EXCLUDED.method, headers=EXCLUDED.headers,
               auth_type=EXCLUDED.auth_type, auth_secret=EXCLUDED.auth_secret, timeout_ms=EXCLUDED.timeout_ms,
               is_active=EXCLUDED.is_active, updated_at=now()`,
            [skillR.rows[0].id, p.org_id, p.name||'default', p.endpoint, p.method||'POST',
             JSON.stringify(p.headers||{}), p.auth_type||'none', p.auth_secret||null,
             p.timeout_ms||30000, p.retry_count||0, p.is_active!==false, p.environment||'all']
          );
          result = { success: true };
        }

      } else if (fn === 'skill/invoke') {
        // p: { org_id, slug, params, callback_name?, user_email? }
        // 1. Lookup callback
        const cbR = await pg.query(
          `SELECT sc.endpoint, sc.method, sc.headers, sc.auth_type, sc.auth_secret, sc.timeout_ms
           FROM fleet.skill_callbacks sc
           JOIN fleet.skills s ON s.id = sc.skill_id
           WHERE sc.org_id=$1 AND s.slug=$2 AND sc.name=$3 AND sc.is_active=true
           LIMIT 1`,
          [p.org_id, p.slug, p.callback_name||'default']
        );
        if (!cbR.rows.length) { result = { error: `No active callback for skill: ${p.slug}` }; }
        else {
          const cb = cbR.rows[0];
          // 2. Execute HTTP callback
          if (['POST','GET','PUT','PATCH','DELETE'].includes(cb.method)) {
            const body = JSON.stringify({ ...p.params, _skill: p.slug, _org: p.org_id });
            const headers = { 'Content-Type': 'application/json', ...(cb.headers||{}) };
            if (cb.auth_type === 'bearer' && cb.auth_secret) headers['Authorization'] = `Bearer ${cb.auth_secret}`;
            const url = new URL(cb.endpoint);
            const isHttps = url.protocol === 'https:';
            const reqMod = isHttps ? require('https') : http;
            const invokeResult = await new Promise((resolve, reject) => {
              const req = reqMod.request({
                hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search, method: cb.method, headers
              }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d))}catch{resolve({raw:d})} }); });
              req.setTimeout(cb.timeout_ms || 30000, () => { req.destroy(); reject(new Error('timeout')); });
              req.on('error', reject);
              if (['POST','PUT','PATCH'].includes(cb.method)) req.write(body);
              req.end();
            });
            result = { success: true, data: invokeResult, skill: p.slug };
          } else {
            result = { error: `Method ${cb.method} not yet supported for invoke (EXEC/SQL require server-side execution)`, skill: p.slug, endpoint: cb.endpoint };
          }
        }

      // ── Tasks ───────────────────────────────────────────────────────────
      } else if (fn === 'tasks/create') {
        const r = await pg.query(
          `INSERT INTO fleet.tasks (org_id, agent_id, user_id, title, description, status, priority, due_at, tags, source_conversation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, title, status, priority, created_at`,
          [p.org_id, p.agent_id || null, p.user_id || null,
           p.title, p.description || null,
           p.status || 'pending', p.priority || 'normal',
           p.due_at || null,
           p.tags ? `{${p.tags.join(',')}}` : null,
           p.source_conversation_id || null]
        );
        result = r.rows[0] ? { task: r.rows[0] } : { task: null };
        if (p.user_id && r.rows[0]) {
          await notifyViaHandoff(pg, p.org_id, p.user_id,
            'New task assigned: ' + r.rows[0].title,
            'Notify the user they have a new task: "' + r.rows[0].title + '". Priority: ' + (p.priority||'normal') + (p.due_at ? ', due: '+new Date(p.due_at).toLocaleDateString() : '') + '. Task ID: ' + r.rows[0].id
          );
        }

      } else if (fn === 'tasks/list') {
        const r = await pg.query(
          `SELECT t.id, t.title, t.description, t.status, t.priority,
                  t.due_at, t.started_at, t.completed_at, t.tags, t.created_at,
                  a.name as agent_name
           FROM fleet.tasks t
           LEFT JOIN fleet.agents a ON a.id = t.agent_id
           WHERE t.org_id = $1
           ORDER BY
             CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
             t.due_at ASC NULLS LAST, t.created_at DESC
           LIMIT 200`,
          [p.org_id]
        );
        result = { tasks: r.rows };

      // ── Knowledge Upsert ─────────────────────────────────────────────────
      // p: { org_id, domain, content, scope, scope_id?, salience?, source_label? }
      // scope: 'org' | 'department' | 'agent' | 'user'
      // scope_id: dept UUID / agent UUID / account UUID (null for org-wide)
      // domain: slug like 'security-guidelines', 'dev-standards', 'it-compliance'
      // Behavior: soft-deletes existing memory for same domain+scope+scope_id, inserts fresh
      } else if (fn === 'knowledge/upsert') {
        const { domain, content, scope, scope_id, salience, source_label } = p;
        if (!domain || !content || !scope) {
          result = { error: 'Required: domain, content, scope' };
        } else {
          // 1. Soft-delete existing memories for this domain+scope+scope_id
          const scopeFilter = scope_id
            ? `AND source_type = $3 AND source_id = $4::uuid`
            : `AND source_type = $3 AND source_id IS NULL`;
          const deleteParams = scope_id
            ? [p.org_id, domain, scope, scope_id]
            : [p.org_id, domain, scope];
          await pg.query(
            `UPDATE fleet.memories SET deleted_at = now()
             WHERE org_id = $1 AND summary = $2 AND deleted_at IS NULL ${scopeFilter}`,
            deleteParams
          );

          // 2. Chunk the content
          const chunks = chunkText(content, 400, 40); // ~400 token chunks, 40 overlap

          // 3. Embed all chunks in one pass
          const vectors = await embedTexts(chunks, GEMINI_KEY);

          const inserted = [];
          for (let i = 0; i < chunks.length; i++) {
            // 4. Insert memory row (use summary field as domain key)
            const chunkLabel = chunks.length > 1 ? `${domain} [${i+1}/${chunks.length}]` : domain;
            const memR = await pg.query(
              `INSERT INTO fleet.memories
                 (org_id, agent_id, user_id, department_id, content, memory_type,
                  visibility, salience, summary, source_type)
               VALUES ($1, $2, $3, $4, $5, 'knowledge', $6, $7, $8, $9)
               RETURNING id`,
              [
                p.org_id,
                scope === 'agent'      ? scope_id : null,
                scope === 'user'       ? scope_id : null,
                scope === 'department' ? scope_id : null,
                chunks[i],
                scope === 'org'        ? 'org' : 'department',
                salience || 0.9,
                domain,           // stored in summary as the upsert key
                source_label || scope
              ]
            );
            const memId = memR.rows[0].id;

            // 5. Insert chunk row (required by search function which joins memory_chunks)
            const chunkR = await pg.query(
              `INSERT INTO fleet.memory_chunks (memory_id, chunk_index, content, token_count)
               VALUES ($1, $2, $3, $4) RETURNING id`,
              [memId, i, chunks[i], Math.ceil(chunks[i].length / 4)]
            );
            const chunkId = chunkR.rows[0].id;

            // 6. Insert embedding linked to chunk_id
            const embStr = '[' + vectors[i].join(',') + ']';
            await pg.query(
              `INSERT INTO fleet.memory_embeddings (memory_id, chunk_id, embedding, embedding_model)
               VALUES ($1, $2, $3::vector, $4)`,
              [memId, chunkId, embStr, 'gemini-embedding-2-preview']
            );
            inserted.push({ id: memId, chunk: i + 1 });
          }

          result = {
            success: true,
            domain,
            scope,
            scope_id: scope_id || null,
            chunks_inserted: inserted.length,
            ids: inserted
          };
        }

      } else if (fn === 'tasks/update') {
        const fields = [];
        const vals = [];
        let i = 1;
        if (p.status)      { fields.push(`status=$${i++}`);      vals.push(p.status); }
        if (p.priority)    { fields.push(`priority=$${i++}`);    vals.push(p.priority); }
        if (p.title)       { fields.push(`title=$${i++}`);       vals.push(p.title); }
        if (p.description !== undefined) { fields.push(`description=$${i++}`); vals.push(p.description); }
        if (p.due_at !== undefined)      { fields.push(`due_at=$${i++}`);      vals.push(p.due_at); }
        if (p.status === 'in_progress' && !p.started_at)  fields.push(`started_at=now()`);
        if (p.status === 'done' || p.status === 'cancelled') fields.push(`completed_at=now()`);
        fields.push(`updated_at=now()`);
        vals.push(p.task_id);
        const r = await pg.query(
          `UPDATE fleet.tasks SET ${fields.join(', ')} WHERE id=$${i} RETURNING id, status, priority, updated_at`,
          vals
        );
        result = { task: r.rows[0] };
        if (r.rows[0]) {
          const tInfo = await pg.query('SELECT user_id, title FROM fleet.tasks WHERE id=$1', [p.task_id]);
          if (tInfo.rows[0] && tInfo.rows[0].user_id) {
            await notifyViaHandoff(pg, p.org_id, tInfo.rows[0].user_id,
              'Task updated: ' + tInfo.rows[0].title,
              'Notify user their task "' + tInfo.rows[0].title + '" was updated.' + (p.status ? ' New status: '+p.status : '') + (p.priority ? ' Priority: '+p.priority : '')
            );
          }
        }

      } else if (fn === 'tasks/assign') {
        const prevR = await pg.query(
          'SELECT user_id, title FROM fleet.tasks WHERE id=$1 AND org_id=$2',
          [p.task_id, p.org_id]
        );
        const prevUserId = prevR.rows[0] ? prevR.rows[0].user_id : null;
        const taskTitle = prevR.rows[0] ? prevR.rows[0].title : 'a task';
        const r = await pg.query(
          'UPDATE fleet.tasks SET user_id=$1, agent_id=$2, updated_at=now() WHERE id=$3 AND org_id=$4 RETURNING id, title, status, user_id',
          [p.user_id, p.agent_id||null, p.task_id, p.org_id]
        );
        result = { task: r.rows[0] || null };
        if (p.user_id) {
          await notifyViaHandoff(pg, p.org_id, p.user_id,
            'Task assigned to you: ' + taskTitle,
            'Notify user they have been assigned task: "' + taskTitle + '". Assigned by: ' + (p.assigned_by_name||'Fleet') + '. Task ID: ' + p.task_id
          );
        }
        if (prevUserId && prevUserId !== p.user_id) {
          await notifyViaHandoff(pg, p.org_id, prevUserId,
            'Task reassigned: ' + taskTitle,
            'Notify user that task "' + taskTitle + '" has been reassigned to someone else.'
          );
        }

      } else if (fn === 'tasks/list/by-tag') {
        const limit = Math.min(p.limit || 50, 200);
        const conditions = ["t.org_id = $1", "t.status != 'cancelled'"];
        const vals = [p.org_id];
        let idx = 2;
        if (p.tags && p.tags.length) {
          conditions.push('t.tags && $' + idx++ + '::text[]');
          vals.push('{' + p.tags.join(',') + '}');
        }
        if (p.user_id)  { conditions.push('t.user_id = $' + idx++ + '::uuid'); vals.push(p.user_id); }
        if (p.status)   { conditions.push('t.status = $' + idx++); vals.push(p.status); }
        if (p.priority) { conditions.push('t.priority = $' + idx++); vals.push(p.priority); }
        const r = await pg.query(
          'SELECT t.id, t.title, t.description, t.status, t.priority, t.due_at, t.tags, t.created_at, t.updated_at, t.parent_task_id, a.name as agent_name, acc.name as assigned_to, acc.department as dept FROM fleet.tasks t LEFT JOIN fleet.agents a ON a.id=t.agent_id LEFT JOIN fleet.accounts acc ON acc.id=t.user_id WHERE ' + conditions.join(' AND ') + ' ORDER BY CASE t.priority WHEN \'urgent\' THEN 1 WHEN \'high\' THEN 2 WHEN \'normal\' THEN 3 ELSE 4 END, t.due_at ASC NULLS LAST, t.created_at DESC LIMIT ' + limit,
          vals
        );
        result = { tasks: r.rows, total: r.rowCount };

      } else if (fn === 'tasks/delete') {
        const prevR = await pg.query(
          'SELECT user_id, title FROM fleet.tasks WHERE id=$1 AND org_id=$2',
          [p.task_id, p.org_id]
        );
        const user_id = prevR.rows[0] ? prevR.rows[0].user_id : null;
        const title = prevR.rows[0] ? prevR.rows[0].title : 'a task';
        const r = await pg.query(
          "UPDATE fleet.tasks SET status='cancelled', completed_at=now(), updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING id, title, status",
          [p.task_id, p.org_id]
        );
        result = { task: r.rows[0] || null };
        if (user_id) {
          await notifyViaHandoff(pg, p.org_id, user_id,
            'Task cancelled: ' + title,
            'Notify user their task "' + title + '" was cancelled by ' + (p.deleted_by_name||'Fleet') + '.'
          );
        }

      // ── Session: get or create active session ──────────────────────────────
      } else if (fn === 'session/active') {
        // p: { org_id, agent_id, platform_chat_id, chat_type, user_id? }
        const activeR = await pg.query(
          `SELECT id, session_number, started_at FROM fleet.sessions
           WHERE agent_id=$1 AND platform_chat_id=$2 AND ended_at IS NULL
           ORDER BY started_at DESC LIMIT 1`,
          [p.agent_id, p.platform_chat_id]
        );
        let session_id, session_number, started_at, is_new;
        if (activeR.rows.length > 0) {
          ({ id: session_id, session_number, started_at } = activeR.rows[0]);
          is_new = false;
        } else {
          const newR = await pg.query(
            `INSERT INTO fleet.sessions (org_id, agent_id, user_id, platform_chat_id, chat_type)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, session_number, started_at`,
            [p.org_id, p.agent_id, p.user_id || null, p.platform_chat_id, p.chat_type || 'direct']
          );
          ({ id: session_id, session_number, started_at } = newR.rows[0]);
          is_new = true;
        }
        // Backfill conversations without a session_id
        await pg.query(
          `UPDATE fleet.conversations SET session_id=$1
           WHERE agent_id=$2 AND platform_conversation_id=$3 AND session_id IS NULL`,
          [session_id, p.agent_id, p.platform_chat_id]
        );
        result = { session_id, session_number, started_at, is_new };

      // ── Session: reset (close current, open new) ────────────────────────────
      } else if (fn === 'session/reset') {
        // p: { org_id, agent_id, platform_chat_id, chat_type, user_id?, reset_by?, admin_check? }
        const reset_by = p.reset_by || 'user';
        // GC admin check
        if (p.admin_check && p.user_id) {
          const adminR = await pg.query(
            `SELECT id FROM fleet.accounts WHERE id=$1 AND role IN ('admin','team_lead')`,
            [p.user_id]
          );
          if (!adminR.rows.length) {
            result = { error: 'Only group admins can reset the session', code: 'UNAUTHORIZED' };
            await pg.end(); res.writeHead(403, CORS); res.end(JSON.stringify(result)); return;
          }
        }
        // Fetch current active session
        const activeR = await pg.query(
          `SELECT id, session_number, summary FROM fleet.sessions
           WHERE agent_id=$1 AND platform_chat_id=$2 AND ended_at IS NULL
           ORDER BY started_at DESC LIMIT 1`,
          [p.agent_id, p.platform_chat_id]
        );
        let old_session = null;
        if (activeR.rows.length > 0) {
          const old = activeR.rows[0];
          await pg.query(
            `UPDATE fleet.sessions SET ended_at=now(), reset_by=$1, reset_by_user_id=$2 WHERE id=$3`,
            [reset_by, p.user_id || null, old.id]
          );
          old_session = { id: old.id, session_number: old.session_number, summary: old.summary };
        }
        // Create new session
        const newR = await pg.query(
          `INSERT INTO fleet.sessions (org_id, agent_id, user_id, platform_chat_id, chat_type)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, session_number`,
          [p.org_id, p.agent_id, p.user_id || null, p.platform_chat_id, p.chat_type || 'direct']
        );
        result = { old_session, new_session: { id: newR.rows[0].id, session_number: newR.rows[0].session_number } };

      // ── Session: list past sessions ─────────────────────────────────────────
      } else if (fn === 'session/list') {
        // p: { org_id, agent_id?, platform_chat_id?, limit? }
        const limit = p.limit || 50;
        const conditions = ['s.org_id=$1'];
        const params = [p.org_id];
        if (p.agent_id) { params.push(p.agent_id); conditions.push(`s.agent_id=$${params.length}`); }
        if (p.platform_chat_id) { params.push(p.platform_chat_id); conditions.push(`s.platform_chat_id=$${params.length}`); }
        params.push(limit);
        const r = await pg.query(
          `SELECT s.id, s.session_number, s.started_at, s.ended_at, s.summary,
                  s.chat_type, s.platform_chat_id, s.reset_by,
                  a.name AS agent_name, a.slug AS agent_slug,
                  COUNT(m.id)::int AS message_count,
                  CASE WHEN s.ended_at IS NULL THEN 'active' ELSE 'closed' END AS status,
                  u.name AS account_name
           FROM fleet.sessions s
           LEFT JOIN fleet.agents a ON a.id = s.agent_id
           LEFT JOIN fleet.conversations c ON c.session_id = s.id
           LEFT JOIN fleet.messages m ON m.conversation_id = c.id
           LEFT JOIN fleet.telegram_bindings tb ON tb.telegram_id = s.platform_chat_id AND tb.org_id = s.org_id
           LEFT JOIN fleet.accounts u ON u.id = tb.account_id
           WHERE ${conditions.join(' AND ')}
           GROUP BY s.id, s.session_number, s.started_at, s.ended_at, s.summary,
                    s.chat_type, s.platform_chat_id, s.reset_by, a.name, a.slug, u.name
           ORDER BY s.started_at DESC LIMIT $${params.length}`,
          params
        );
        result = { sessions: r.rows };

      // ── Session: resume a past session ──────────────────────────────────────
      } else if (fn === 'session/resume') {
        // p: { org_id, agent_id, platform_chat_id, session_number, user_id? }
        const sessR = await pg.query(
          `SELECT id, session_number, summary, started_at, ended_at FROM fleet.sessions
           WHERE agent_id=$1 AND platform_chat_id=$2 AND session_number=$3`,
          [p.agent_id, p.platform_chat_id, p.session_number]
        );
        if (!sessR.rows.length) {
          result = { error: `Session #${p.session_number} not found` };
        } else {
          const sess = sessR.rows[0];
          // Close any other active session for this chat
          await pg.query(
            `UPDATE fleet.sessions SET ended_at=now(), reset_by='agent'
             WHERE agent_id=$1 AND platform_chat_id=$2 AND ended_at IS NULL AND id != $3`,
            [p.agent_id, p.platform_chat_id, sess.id]
          );
          // Reactivate the requested session
          await pg.query(
            `UPDATE fleet.sessions SET ended_at=NULL, reset_by=NULL WHERE id=$1`,
            [sess.id]
          );
          // Fetch last 20 messages from this session's conversations
          const msgsR = await pg.query(
            `SELECT m.role, m.content, m.created_at
             FROM fleet.messages m
             JOIN fleet.conversations c ON c.id = m.conversation_id
             WHERE c.session_id=$1
             ORDER BY m.created_at DESC LIMIT 20`,
            [sess.id]
          );
          result = {
            session: { id: sess.id, session_number: sess.session_number, summary: sess.summary, started_at: sess.started_at, ended_at: sess.ended_at },
            messages: msgsR.rows,
            reactivated: true
          };
        }

      // ── Session: stats ──────────────────────────────────────────────────────────
      } else if (fn === "session/stats") {
        // p: { org_id }
        const statsR = await pg.query(`
          SELECT
            COUNT(*)                                          AS total,
            COUNT(*) FILTER (WHERE ended_at IS NULL)          AS active,
            COUNT(*) FILTER (WHERE started_at::date = CURRENT_DATE) AS today,
            ROUND(AVG(msg_counts.cnt), 1)                    AS avg_messages,
            COUNT(*) FILTER (WHERE chat_type = 'direct')    AS dm_count,
            COUNT(*) FILTER (WHERE chat_type = 'group')     AS gc_count
          FROM fleet.sessions s
          LEFT JOIN (
            SELECT c.session_id, COUNT(m.id) AS cnt
            FROM fleet.conversations c
            JOIN fleet.messages m ON m.conversation_id = c.id
            GROUP BY c.session_id
          ) msg_counts ON msg_counts.session_id = s.id
          WHERE s.org_id = $1
        `, [p.org_id]);

        const byDayR = await pg.query(`
          SELECT started_at::date AS day, COUNT(*) AS count
          FROM fleet.sessions
          WHERE org_id = $1 AND started_at >= now() - interval '30 days'
          GROUP BY day ORDER BY day ASC
        `, [p.org_id]);

        const byAgentR = await pg.query(`
          SELECT a.name AS agent_name, a.slug, COUNT(s.id) AS session_count,
            COUNT(s.id) FILTER (WHERE s.ended_at IS NULL) AS active_count
          FROM fleet.sessions s
          JOIN fleet.agents a ON a.id = s.agent_id
          WHERE s.org_id = $1
          GROUP BY a.id, a.name, a.slug
          ORDER BY session_count DESC
        `, [p.org_id]);

        const resetR = await pg.query(`
          SELECT reset_by, COUNT(*) AS count
          FROM fleet.sessions
          WHERE org_id = $1 AND reset_by IS NOT NULL
          GROUP BY reset_by
        `, [p.org_id]);

        result = {
          summary: statsR.rows[0],
          by_day: byDayR.rows,
          by_agent: byAgentR.rows,
          reset_reasons: resetR.rows
        };

      // ── Session: heatmap ─────────────────────────────────────────────────────
      } else if (fn === "session/heatmap") {
        // p: { org_id }
        const r = await pg.query(`
          SELECT
            EXTRACT(DOW FROM m.created_at AT TIME ZONE 'Asia/Manila')::int AS day_of_week,
            EXTRACT(HOUR FROM m.created_at AT TIME ZONE 'Asia/Manila')::int AS hour,
            COUNT(*)::int AS message_count
          FROM fleet.messages m
          JOIN fleet.conversations c ON c.id = m.conversation_id
          WHERE c.org_id = $1
            AND m.created_at >= now() - interval '30 days'
          GROUP BY day_of_week, hour
          ORDER BY day_of_week, hour
        `, [p.org_id]);
        result = { heatmap: r.rows };

      } else {
        result = { error: `Unknown endpoint: ${fn}` };
      }

      await pg.end();
      res.writeHead(200, CORS);
      res.end(JSON.stringify(result));

    } catch (e) {
      await pg.end().catch(() => {});
      console.error(`[fleet-api] Error on /${fn}:`, e.message);
      res.writeHead(500, CORS);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Fleet API proxy running on http://127.0.0.1:${PORT}`);
  console.log(`Database: ${LOCAL_DB_URL.replace(/:\/\/.*@/, '://***@')}`);
});
