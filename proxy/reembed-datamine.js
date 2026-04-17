const { Client } = require('pg');
const https = require('https');

const GEMINI_KEY = 'AIzaSyBAbuhtpfMVbq3bPRHBKkm0YwpYAxKxv_c';
const DESCRIPTION = "Use Prospector / Datamine to pull B2B contact lists from Callbox Data Warehouse. Triggers on: use prospector, run prospector, pull from prospector, pull records, get contacts, find leads, data count, check leads, pull Australian records, run a count, ICP pull, lead search, do you have prospector, prospector skill, datamine skill, what skills do you have, can you run prospector. Filters: country, state, industry, job title, employee size, revenue, tech stack.";

async function embed(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'models/gemini-embedding-001', content: { parts: [{ text }] } });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        resolve(parsed.embedding.values);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const client = new Client({ connectionString: 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev' });
  await client.connect();
  console.log('Generating embedding...');
  const vec = await embed(DESCRIPTION);
  const vecStr = '[' + vec.join(',') + ']';
  await client.query(
    `UPDATE fleet.skills SET description_embedding = $1::vector WHERE slug = 'datamine'`,
    [vecStr]
  );
  console.log('Done. Vector dims:', vec.length);
  await client.end();
}

main().catch(console.error);
