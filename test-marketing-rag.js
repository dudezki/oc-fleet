const https = require('https');
const { Pool } = require('pg');
const pg = new Pool({ connectionString: 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev' });
const GEMINI_KEY = 'AIzaSyBAbuhtpfMVbq3bPRHBKkm0YwpYAxKxv_c';

async function embedText(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'models/gemini-embedding-2-preview', content: { parts: [{ text }] }, outputDimensionality: 1536 });
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
        catch(e) { reject(new Error(d)); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function main() {
  const query = 'marketing lead qualification';
  console.log('Searching for:', query);
  const vec = await embedText(query);
  const vecStr = '[' + vec.join(',') + ']';
  const r = await pg.query(
    "SELECT * FROM fleet.search_memories_scored($1, $2::vector, 5, $3, NULL, 0.35, 0.25, 0.25, 0.15)",
    ['f86d92cb-db10-43ff-9ff2-d69c319d272d', vecStr, '792ceca1-77d9-425a-85c0-c7903eeb5b13']
  );
  console.log('Results:', r.rows.length);
  r.rows.forEach((row, i) => {
    console.log(`\n[${i+1}] score=${row.combined_score.toFixed(3)} semantic=${row.semantic_score.toFixed(3)}`);
    console.log(row.content.slice(0, 150));
  });
  await pg.end();
}
main();
