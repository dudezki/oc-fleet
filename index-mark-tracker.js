const XLSX = require('/tmp/node_modules/xlsx');
const https = require('https');
const { Pool } = require('pg');

const pg = new Pool({ connectionString: 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev' });
const GEMINI_KEY = 'AIzaSyBAbuhtpfMVbq3bPRHBKkm0YwpYAxKxv_c';
const ORG_ID = 'f86d92cb-db10-43ff-9ff2-d69c319d272d';
const AGENT_ID = '792ceca1-77d9-425a-85c0-c7903eeb5b13'; // Fleet-Marketing
const USER_ID = '7cbaa587-5edc-4c24-ada5-494f8b5bb07a'; // Mark Garlitos

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

async function insertMemory(content) {
  const r = await pg.query(
    `INSERT INTO fleet.memories (org_id, agent_id, user_id, content, memory_type, visibility, salience, source_type)
     VALUES ($1, $2, $3, $4, 'knowledge', 'org', 0.8, 'tracker')
     RETURNING id`,
    [ORG_ID, AGENT_ID, USER_ID, content]
  );
  return r.rows[0].id;
}

async function main() {
  const wb = XLSX.readFile('/tmp/drive_download/files/Mark_Master_Tracker (19).xlsx');
  
  // Index Master Tracker — chunk by 20 rows
  const ws = wb.Sheets['Master Tracker'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const headers = rows[0];
  const dataRows = rows.slice(1).filter(r => r[3] && r[4]); // must have Name + Company
  
  console.log('Total prospect rows:', dataRows.length);
  
  const CHUNK_SIZE = 20;
  let chunkCount = 0;
  
  for (let i = 0; i < dataRows.length; i += CHUNK_SIZE) {
    const chunk = dataRows.slice(i, i + CHUNK_SIZE);
    const content = `# Mark Garlitos — Master Tracker (rows ${i+1}-${i+chunk.length})\n\n` +
      chunk.map(r => {
        const name = r[3] || '';
        const company = r[4] || '';
        const country = r[5] || '';
        const email = r[6] || '';
        const status = r[13] || '';
        const notation = r[8] || '';
        const nextAction = r[15] || '';
        const nextActionDate = r[16] || '';
        const priority = r[9] || '';
        const leadScore = r[12] || '';
        return `- ${name} | ${company} | ${country} | ${email} | Status: ${status} | Priority: ${priority} | Score: ${leadScore} | Next: ${nextAction} (${nextActionDate}) | Notes: ${notation}`.slice(0, 400);
      }).join('\n');
    
    try {
      const id = await insertMemory(content);
      const vec = await embedText(content);
      const vecStr = '[' + vec.join(',') + ']';
      await pg.query('INSERT INTO fleet.memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)', [id, vecStr]);
      chunkCount++;
      console.log('✅ Chunk ' + chunkCount + ' (rows ' + (i+1) + '-' + (i+chunk.length) + ')');
    } catch(e) {
      console.error('❌ Chunk ' + chunkCount + ': ' + e.message.slice(0, 100));
    }
    await new Promise(r => setTimeout(r, 600));
  }

  // Index Command Center summary
  const wsCmd = wb.Sheets['📊 Command Center'];
  const cmdData = XLSX.utils.sheet_to_json(wsCmd, { header: 1 });
  const cmdContent = '# Mark Garlitos — Command Center / Quota Scorecard (April 2026)\n\n' +
    cmdData.filter(r => r.some(c => c)).map(r => r.filter(c => c).join(' | ')).join('\n');
  
  try {
    const id = await insertMemory(cmdContent);
    const vec = await embedText(cmdContent);
    const vecStr = '[' + vec.join(',') + ']';
    await pg.query('INSERT INTO fleet.memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)', [id, vecStr]);
    console.log('✅ Command Center indexed');
  } catch(e) {
    console.error('❌ Command Center: ' + e.message.slice(0, 100));
  }

  await pg.end();
  console.log('Done. Total chunks: ' + chunkCount);
}
main();
