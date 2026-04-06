// backfill-embeddings.js — Backfill embeddings for memories missing from fleet.memory_embeddings
const { Client } = require('pg');
const { embedTexts } = require('../proxy/chunker');

const PG_URL = 'postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev';
const GEMINI_API_KEY = 'AIzaSyAksgdKNgnQ74ShoABJ2r6iik3yOXkqZUk';
const EMBEDDING_MODEL = 'gemini-embedding-2-preview';

async function main() {
  const pg = new Client({ connectionString: PG_URL, ssl: false });
  await pg.connect();
  console.log('[backfill] Connected to DB');

  try {
    // Step 1: Find memories with no embeddings
    const { rows: memories } = await pg.query(`
      SELECT m.id, m.content
      FROM fleet.memories m
      WHERE m.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM fleet.memory_embeddings me WHERE me.memory_id = m.id
        )
      ORDER BY m.created_at
    `);

    console.log(`[backfill] Found ${memories.length} memories without embeddings`);

    let done = 0;
    let errors = 0;

    for (const memory of memories) {
      try {
        // Step 2a: Check/create memory_chunk
        const { rows: existingChunks } = await pg.query(
          `SELECT id FROM fleet.memory_chunks WHERE memory_id = $1 ORDER BY chunk_index LIMIT 1`,
          [memory.id]
        );

        let chunkId;
        if (existingChunks.length > 0) {
          chunkId = existingChunks[0].id;
        } else {
          const tokenCount = Math.ceil((memory.content || '').length / 4);
          const { rows: inserted } = await pg.query(
            `INSERT INTO fleet.memory_chunks (memory_id, chunk_index, content, token_count)
             VALUES ($1, 0, $2, $3)
             RETURNING id`,
            [memory.id, memory.content, tokenCount]
          );
          chunkId = inserted[0].id;
          console.log(`[backfill]   Created chunk for memory ${memory.id}`);
        }

        // Step 2b: Generate embedding
        const [vector] = await embedTexts([memory.content || ''], GEMINI_API_KEY);

        // Step 2c: Insert into memory_embeddings
        const embeddingStr = '[' + vector.join(',') + ']';
        await pg.query(
          `INSERT INTO fleet.memory_embeddings (memory_id, chunk_id, embedding, embedding_model)
           VALUES ($1, $2, $3::vector, $4)
           ON CONFLICT DO NOTHING`,
          [memory.id, chunkId, embeddingStr, EMBEDDING_MODEL]
        );

        done++;
        console.log(`[backfill] [${done}/${memories.length}] Embedded memory ${memory.id}`);
      } catch (err) {
        errors++;
        console.error(`[backfill] ERROR on memory ${memory.id}: ${err.message}`);
      }
    }

    console.log(`\n[backfill] Done. ${done} embedded, ${errors} errors out of ${memories.length} total.`);
  } finally {
    await pg.end().catch(() => {});
  }
}

main().catch(err => {
  console.error('[backfill] Fatal:', err.message);
  process.exit(1);
});
