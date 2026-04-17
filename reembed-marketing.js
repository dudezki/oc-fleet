const { Pool } = require('pg');
const https = require('https');

const pg = new Pool({ connectionString: 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev' });
const GEMINI_KEY = 'AIzaSyBAbuhtpfMVbq3bPRHBKkm0YwpYAxKxv_c';

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
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).embedding.values); }
        catch(e) { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const r = await pg.query(
    "SELECT m.id, m.content FROM fleet.memories m LEFT JOIN fleet.memory_embeddings e ON e.memory_id = m.id WHERE m.org_id = 'f86d92cb-db10-43ff-9ff2-d69c319d272d' AND m.deleted_at IS NULL AND m.content ILIKE '%Standardized Marketing Lead Qualification%' AND e.memory_id IS NULL"
  );
  console.log('Embedding ' + r.rows.length + ' chunks...');
  for (const row of r.rows) {
    try {
      const vec = await embedText(row.content);
      const vecStr = '[' + vec.join(',') + ']';
      await pg.query(
        'INSERT INTO fleet.memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)',
        [row.id, vecStr]
      );
      console.log('OK ' + row.id.slice(0,8));
    } catch(e) {
      console.error('FAIL ' + row.id.slice(0,8) + ': ' + e.message.slice(0,100));
    }
    await new Promise(res => setTimeout(res, 500));
  }
  await pg.end();
  console.log('Done.');
}
main();
