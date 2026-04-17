#!/usr/bin/env node
/**
 * Fleet v1 → v2 Memory Migration
 * Reads extracted memory files and inserts into fleet.memories + knowledge/upsert
 *
 * Usage: node migrate-fleet-v1-memories.js [--dry-run] [--bot cb-main]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev' });

const ORG_ID = 'f86d92cb-db10-43ff-9ff2-d69c319d272d';
const EXPORT_DIR = '/tmp/fleet-memory-export-extracted/fleet-memory-export';
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_BOT = process.argv.includes('--bot') ? process.argv[process.argv.indexOf('--bot') + 1] : null;
const PROXY_URL = 'http://127.0.0.1:20000';

// v1 bot slug → v2 agent_id mapping
const BOT_MAP = {
  'cb-main':   '82061d1c-2c79-4cfb-9e18-b8233b95a7c2', // Fleet-Manager
  'sales':     'b81c0d8a-3f76-43fe-b2e5-2537801085dc', // Fleet-Sales
  'dev':       '87a2838e-e145-4f5c-99e2-c759f0591cba', // Fleet-Dev
  'support':   '325e5143-3c0b-4d65-b548-a34cbdba5949', // Fleet-Support (cs → support)
  'cs':        '325e5143-3c0b-4d65-b548-a34cbdba5949', // Fleet-Support
  'hr':        '8a2ce3b0-ed67-460b-a79e-e3baeeacc51e', // Fleet-HR
  'finance':   'd6a557d1-6e81-4144-991d-d26c68a1f64f', // Fleet-Finance
  'it':        '20dc090b-90a3-403f-acc3-a1ac7008596d', // Fleet-IT
  'marketing': '792ceca1-77d9-425a-85c0-c7903eeb5b13', // Fleet-Marketing
  'exec':      '82061d1c-2c79-4cfb-9e18-b8233b95a7c2', // Fleet-Manager (exec → manager)
  'bigbox':    '87a2838e-e145-4f5c-99e2-c759f0591cba', // Fleet-Dev (BigBox project)
  'db':        '87a2838e-e145-4f5c-99e2-c759f0591cba', // Fleet-Dev (DB bot)
  'cbee':      '87a2838e-e145-4f5c-99e2-c759f0591cba', // Fleet-Dev (Engineering)
  'testbed':   '87a2838e-e145-4f5c-99e2-c759f0591cba', // Fleet-Dev (Testbed)
  'doctor':    '20dc090b-90a3-403f-acc3-a1ac7008596d', // Fleet-IT (System health)
  'ldrec':     'b88cfe75-aa66-4a9a-8c71-25b4d3f0aca8', // Fleet-Upskill
  'messenger': '325e5143-3c0b-4d65-b548-a34cbdba5949', // Fleet-Support
};

// DM slug → search term for fleet.accounts lookup
const DM_USER_MAP = {
  'brian':    { name: 'Brian Butler' },
  'bryan':    { email: 'bryanb@callboxinc.com' },
  'bryankb':  { email: 'bryankb@callboxinc.com' },
  'carmi':    { name: 'Carmi' },
  'diana':    { name: 'Diana' },
  'eliana':   { name: 'Eliana' },
  'emerald':  { email: 'emeralduy@callboxinc.com' },
  'femia':    { email: 'femiaa@callboxinc.com' },
  'ian':      { name: 'Ian' },
  'irah':     { name: 'Irah' },
  'jaime':    { name: 'Jaime' },
  'jaylord':  { email: 'jaylordf@callboxinc.com' },
  'jessica':  { email: 'jessicas@callboxinc.com' },
  'jhesrhel': { name: 'Jhesrhel' },
  'joe':      { name: 'Joe' },
  'josette':  { email: 'josettev@callboxinc.com' },
  'jp':       { name: 'JP' },
  'lucky':    { email: 'luckyf@callboxinc.com' },
  'mark':     { name: 'Mark' },
  'matthew':  { name: 'Matthew' },
  'melisa':   { name: 'Melisa' },
  'narz':     { name: 'Narz' },
  'rebecca':  { name: 'Rebecca' },
  'rom':      { name: 'Rom' },
  'rv':       { name: 'RV' },
  'shai':     { name: 'Shai' },
  'sheng':    { name: 'Sheng' },
  'sheryll':  { email: 'sheryll@callboxinc.com' },
  'sol':      { name: 'Sol' },
};

// Cache resolved user IDs
const userIdCache = {};

async function resolveUserId(dmSlug) {
  if (userIdCache[dmSlug] !== undefined) return userIdCache[dmSlug];
  const hint = DM_USER_MAP[dmSlug];
  if (!hint) { userIdCache[dmSlug] = null; return null; }
  let r;
  if (hint.email) {
    r = await pool.query(`SELECT id FROM fleet.accounts WHERE email=$1 AND org_id=$2`, [hint.email, ORG_ID]);
  } else {
    r = await pool.query(`SELECT id FROM fleet.accounts WHERE name ILIKE $1 AND org_id=$2 LIMIT 1`, [`%${hint.name}%`, ORG_ID]);
  }
  const id = r.rows[0]?.id || null;
  userIdCache[dmSlug] = id;
  if (id) console.log(`  [user] dm-${dmSlug} → ${id}`);
  else console.log(`  [user] dm-${dmSlug} → not found`);
  return id;
}

// Files to SKIP (SQL, non-memory, sensitive)
const SKIP_PATTERNS = [
  /api-keys\.md$/,
  /\.sql$/,
  /MIGRATION-LOG/,
  /migrations\//,
  /bigbox-migrations\//,
  /dbml\//,
];

// Classify file type
function classifyFile(filePath) {
  const base = path.basename(filePath);
  if (base === 'MEMORY.md') return 'long_term';
  if (base.match(/^\d{4}-\d{2}-\d{2}\.md$/)) return 'episodic';
  if (filePath.includes('/knowledge/')) return 'knowledge';
  if (base.startsWith('dm-')) return 'episodic'; // DM context
  if (base.includes('group-chat')) return 'episodic';
  if (base.includes('handoff')) return 'episodic';
  if (base.includes('shared-context')) return 'long_term';
  return 'long_term'; // default
}

function shouldSkip(filePath) {
  return SKIP_PATTERNS.some(p => p.test(filePath));
}

async function resolveAgentId(slug) {
  if (BOT_MAP[slug]) return BOT_MAP[slug];
  const r = await pool.query('SELECT id FROM fleet.agents WHERE slug=$1 AND org_id=$2', [slug, ORG_ID]);
  return r.rows[0]?.id || null;
}

async function insertMemory(agentId, content, memoryType, source, userId = null) {
  if (DRY_RUN) {
    console.log(`  [DRY] INSERT memory: agent=${agentId} user=${userId||'none'} type=${memoryType} size=${content.length} source=${source}`);
    return;
  }
  if (userId) {
    await pool.query(
      `INSERT INTO fleet.memories (org_id, agent_id, user_id, content, memory_type, salience, visibility, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'org',now())
       ON CONFLICT DO NOTHING`,
      [ORG_ID, agentId, userId, content.trim(), memoryType, memoryType === 'long_term' ? 0.9 : 0.6]
    );
  } else {
    await pool.query(
      `INSERT INTO fleet.memories (org_id, agent_id, content, memory_type, salience, visibility, created_at)
       VALUES ($1,$2,$3,$4,$5,'org',now())
       ON CONFLICT DO NOTHING`,
      [ORG_ID, agentId, content.trim(), memoryType, memoryType === 'long_term' ? 0.9 : 0.6]
    );
  }
}

async function upsertKnowledge(agentId, content, domain, sourceLabel) {
  if (DRY_RUN) {
    console.log(`  [DRY] UPSERT knowledge: domain=${domain} size=${content.length}`);
    return;
  }
  try {
    const resp = await fetch(`${PROXY_URL}/fleet-api/knowledge/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_id: ORG_ID,
        agent_id: agentId,
        domain,
        scope: 'org',
        salience: 0.85,
        source_label: sourceLabel,
        content: content.trim(),
      })
    });
    if (!resp.ok) console.warn(`  WARN knowledge upsert failed: ${resp.status}`);
  } catch(e) {
    console.warn(`  WARN knowledge upsert error: ${e.message}`);
  }
}

async function migrateBot(botSlug) {
  const botDir = path.join(EXPORT_DIR, botSlug);
  if (!fs.existsSync(botDir)) { console.log(`  SKIP: ${botDir} not found`); return; }

  const agentId = await resolveAgentId(botSlug);
  if (!agentId) { console.log(`  SKIP: no agent mapping for ${botSlug}`); return; }

  console.log(`\n📦 Migrating ${botSlug} → agent ${agentId}`);

  const files = [];
  function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).isDirectory()) { walk(fp); continue; }
      if (fp.endsWith('.md')) files.push(fp);
    }
  }
  walk(botDir);

  let inserted = 0, skipped = 0;

  for (const fp of files) {
    const rel = fp.replace(botDir + '/', '');
    if (shouldSkip(rel)) { skipped++; continue; }

    const content = fs.readFileSync(fp, 'utf8').trim();
    if (!content || content.length < 50) { skipped++; continue; }

    const type = classifyFile(fp);
    const base = path.basename(fp, '.md');

    if (type === 'knowledge') {
      const domain = `v1-${botSlug}-${base.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
      await upsertKnowledge(agentId, content, domain, `Fleet v1 / ${botSlug} / ${base}`);
    } else {
      // Resolve user_id for DM files
      let userId = null;
      const dmMatch = base.match(/^dm-(.+)$/);
      if (dmMatch) userId = await resolveUserId(dmMatch[1]);
      await insertMemory(agentId, content, type, rel, userId);
    }
    inserted++;
    process.stdout.write('.');
  }

  console.log(`\n  ✅ ${inserted} files migrated, ${skipped} skipped`);
  return { inserted, skipped };
}

async function main() {
  console.log(`Fleet v1 → v2 Memory Migration${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log('='.repeat(50));

  const manifest = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, 'MANIFEST.json'), 'utf8'));
  const bots = ONLY_BOT ? [ONLY_BOT] : Object.keys(manifest.bots).filter(b => !b.includes(' '));

  let total = { inserted: 0, skipped: 0 };

  for (const bot of bots) {
    const result = await migrateBot(bot);
    if (result) {
      total.inserted += result.inserted;
      total.skipped += result.skipped;
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Total: ${total.inserted} migrated, ${total.skipped} skipped`);
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
