const fs = require('fs');
const https = require('https');
const { Pool } = require('pg');

const pg = new Pool({ connectionString: 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev' });
const GEMINI_KEY = 'AIzaSyBAbuhtpfMVbq3bPRHBKkm0YwpYAxKxv_c';
const ORG_ID = 'f86d92cb-db10-43ff-9ff2-d69c319d272d';
const AGENT_ID = '792ceca1-77d9-425a-85c0-c7903eeb5b13';
const USER_ID = '7cbaa587-5edc-4c24-ada5-494f8b5bb07a';

// Mark-ONLY files
const FILES = [
  '/tmp/fleet-memory-export-extracted/fleet-memory-export/cb-main/memory/dm-mark.md',
  '/tmp/fleet-memory-export-extracted/fleet-memory-export/cb-main/memory/mark-bot-onboarding.md',
  '/tmp/fleet-memory-export-extracted/fleet-memory-export/testbed/MEMORY.md',
  '/tmp/fleet-memory-export-extracted/fleet-memory-export/testbed/memory/2026-04-01.md',
  '/tmp/fleet-memory-export-extracted/fleet-memory-export/testbed/memory/2026-04-02.md',
];

async function embedText(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'models/gemini-embedding-2-preview',
      content: { parts: [{ text: text.slice(0, 8000) }] },
      outputDimensionality: 1536
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/gemini-embedding-2-preview:embedContent?key=' + GEMINI_KEY,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).embedding.values); }
        catch(e) { reject(new Error(d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function chunkText(text, maxChars) {
  const chunks = [];
  const lines = text.split('\n');
  let current = '';
  for (const line of lines) {
    if ((current + '\n' + line).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = line;
    } else {
      current += '\n' + line;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function indexFile(filePath) {
  if (!fs.existsSync(filePath)) { console.log('⏭ not found:', filePath); return; }
  const content = fs.readFileSync(filePath, 'utf8');
  const chunks = chunkText(content, 6000).filter(c => c.length >= 50);
  const label = filePath.split('/').pop();
  let indexed = 0;
  for (const chunk of chunks) {
    try {
      const r = await pg.query(
        `INSERT INTO fleet.memories (org_id, agent_id, user_id, content, memory_type, visibility, salience, source_type)
         VALUES ($1,$2,$3,$4,'knowledge','org',0.9,'mark-export') RETURNING id`,
        [ORG_ID, AGENT_ID, USER_ID, chunk]
      );
      const vec = await embedText(chunk);
      await pg.query('INSERT INTO fleet.memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)', [r.rows[0].id, '[' + vec.join(',') + ']']);
      indexed++;
    } catch(e) { console.error('  ❌', e.message.slice(0,80)); }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('✅', label, '—', indexed, 'chunks');
}

async function main() {
  for (const f of FILES) await indexFile(f);
  await pg.end();
  console.log('Done.');
}
main();
