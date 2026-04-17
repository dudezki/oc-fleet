const fs = require('fs');
const path = require('path');
const https = require('https');
const { Pool } = require('pg');

const pg = new Pool({ connectionString: 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev' });
const GEMINI_KEY = 'AIzaSyBAbuhtpfMVbq3bPRHBKkm0YwpYAxKxv_c';
const ORG_ID = 'f86d92cb-db10-43ff-9ff2-d69c319d272d';
const AGENT_ID = '792ceca1-77d9-425a-85c0-c7903eeb5b13'; // Fleet-Marketing
const USER_ID = '7cbaa587-5edc-4c24-ada5-494f8b5bb07a'; // Mark Garlitos

const MARKETING_EXPORT = '/tmp/fleet-memory-export-extracted/fleet-memory-export/marketing';

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

async function insertMemory(content, memType) {
  const r = await pg.query(
    `INSERT INTO fleet.memories (org_id, agent_id, user_id, content, memory_type, visibility, salience, source_type)
     VALUES ($1, $2, $3, $4, $5, 'org', 0.8, 'memory-export')
     RETURNING id`,
    [ORG_ID, AGENT_ID, USER_ID, content, memType || 'knowledge']
  );
  return r.rows[0].id;
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

async function indexFile(filePath, label) {
  const content = fs.readFileSync(filePath, 'utf8');
  const chunks = chunkText(content, 6000);
  let indexed = 0;
  for (const chunk of chunks) {
    if (chunk.length < 50) continue;
    try {
      const id = await insertMemory(chunk, 'knowledge');
      const vec = await embedText(chunk);
      const vecStr = '[' + vec.join(',') + ']';
      await pg.query('INSERT INTO fleet.memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)', [id, vecStr]);
      indexed++;
    } catch(e) {
      console.error('  ❌ chunk error:', e.message.slice(0, 80));
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('✅', label, '—', indexed, 'chunks');
}

async function main() {
  // Get all .md files from marketing export
  const dirs = ['memory', 'knowledge'];
  const files = [];

  for (const dir of dirs) {
    const dirPath = path.join(MARKETING_EXPORT, dir);
    if (fs.existsSync(dirPath)) {
      fs.readdirSync(dirPath)
        .filter(f => f.endsWith('.md'))
        .forEach(f => files.push({ path: path.join(dirPath, f), label: dir + '/' + f }));
    }
  }

  // Also MEMORY.md at root
  const memRoot = path.join(MARKETING_EXPORT, 'MEMORY.md');
  if (fs.existsSync(memRoot)) files.push({ path: memRoot, label: 'MEMORY.md' });

  console.log('Files to index:', files.length);
  for (const f of files) {
    await indexFile(f.path, f.label);
  }

  await pg.end();
  console.log('\nAll done!');
}
main();
