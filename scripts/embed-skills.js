#!/usr/bin/env node
// embed-skills.js — Embed all active skills into fleet.skills.description_embedding
// Uses gemini-embedding-001 with outputDimensionality: 768

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Load .env manually
const envPath = path.join(__dirname, '../.env');
const envVars = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) envVars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
}
const GEMINI_KEY = process.env.GEMINI_API_KEY || envVars.GEMINI_API_KEY;
const DB_URL = process.env.DATABASE_URL || envVars.DATABASE_URL || 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev';

if (!GEMINI_KEY) { console.error('No GEMINI_API_KEY'); process.exit(1); }

function embedText(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] }
    });
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_KEY}`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          const values = d?.embedding?.values;
          if (!values) reject(new Error(`No embedding values: ${data.slice(0, 200)}`));
          else resolve(values);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  const { rows: skills } = await client.query(
    `SELECT id, slug, name, description FROM fleet.skills WHERE is_active = true ORDER BY slug`
  );
  console.log(`Embedding ${skills.length} skills...`);

  const BATCH_SIZE = 5;
  let ok = 0, skipped = 0, failed = 0;

  for (let i = 0; i < skills.length; i += BATCH_SIZE) {
    const batch = skills.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async skill => {
      if (!skill.description && !skill.name) { skipped++; return; }
      const text = `${skill.name}: ${skill.description || ''}`.trim();
      try {
        const vec = await embedText(text);
        const vecStr = `[${vec.join(',')}]`;
        await client.query(
          `UPDATE fleet.skills SET description_embedding = $1::vector WHERE id = $2`,
          [vecStr, skill.id]
        );
        console.log(`  ✅ ${skill.slug}`);
        ok++;
      } catch (e) {
        console.error(`  ❌ ${skill.slug}: ${e.message}`);
        failed++;
      }
    }));
    if (i + BATCH_SIZE < skills.length) await sleep(1000);
  }

  console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed}`);
  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
