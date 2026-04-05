// chunker.js — RAG memory extraction + embedding pipeline
const Anthropic = require("@anthropic-ai/sdk");
const { Client } = require("pg");
const https = require("https");

const ORG_ID = "f86d92cb-db10-43ff-9ff2-d69c319d272d";
const CHUNK_SIZE = 512; // tokens approx (use chars/4 as proxy)
const CHUNK_OVERLAP = 50;
const TRIGGER_EVERY = 5; // process after every N new messages

// Split text into overlapping chunks (~chunkSize tokens, using chars/4 as proxy)
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const charSize = chunkSize * 4;
  const charOverlap = overlap * 4;
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + charSize, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start += charSize - charOverlap;
  }
  return chunks;
}

// Embed an array of texts via Gemini gemini-embedding-2-preview (1536-dim)
async function embedTexts(texts, apiKey) {
  const embeddings = [];
  for (const text of texts) {
    const body = JSON.stringify({
      model: 'models/gemini-embedding-2-preview',
      content: { parts: [{ text }] },
      outputDimensionality: 1536,
    });
    const vector = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/gemini-embedding-2-preview:embedContent?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(d);
            if (parsed.error) return reject(new Error(parsed.error.message));
            resolve(parsed.embedding.values);
          } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
    embeddings.push(vector);
  }
  return embeddings;
}

// Use Claude to extract structured memories from conversation messages
async function extractMemories(messages, anthropicKey) {
  const client = new Anthropic({ apiKey: anthropicKey });

  const systemPrompt = `You are a memory extraction system. Given a conversation, extract key facts worth remembering.
Return a JSON array of memory objects. Each object:
{
  "content": "concise fact statement",
  "memory_type": "episodic|long_term|knowledge",
  "salience": 0.0-1.0,
  "entities": [{"name": "...", "type": "person|company|product|project|other"}],
  "summary": "one-line summary"
}
Only extract genuinely useful facts. Skip pleasantries. Return [] if nothing worth remembering.
Return ONLY valid JSON array, no markdown.`;

  const userMessage = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  let response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });
      break;
    } catch (e) {
      if (e.status === 429 && attempt < 3) {
        const wait = attempt * 15000;
        console.log(`[chunker] rate limited, retrying in ${wait/1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      } else throw e;
    }
  }

  let text = response.content[0].text.trim();
  // Strip markdown code fences if present
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("[chunker] Failed to parse Claude response:", text.slice(0, 200));
    return [];
  }
}

// Main pipeline: extract memories, chunk, embed, and store for a conversation
async function processConversation(conversationId, pgUrl, anthropicKey, openaiKey) {
  const pg = new Client({
    connectionString: pgUrl,
    ssl: pgUrl.includes("supabase") ? { rejectUnauthorized: false } : false,
  });
  await pg.connect();

  try {
    // 1. Check total message count — only run every TRIGGER_EVERY messages
    const countR = await pg.query(
      `SELECT COUNT(*) FROM fleet.messages WHERE conversation_id = $1`,
      [conversationId]
    );
    const totalCount = parseInt(countR.rows[0].count, 10);
    if (totalCount % TRIGGER_EVERY !== 0) {
      return { skipped: true };
    }

    // 2. Load last 20 messages for context (reversed to chronological order)
    const msgR = await pg.query(
      `SELECT id, role, content, created_at FROM fleet.messages
       WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [conversationId]
    );
    const messages = msgR.rows.reverse();

    if (messages.length === 0) return { memoriesCreated: 0, chunksCreated: 0, embeddingsCreated: 0 };

    // 3. Get agent_id from conversation
    const convR = await pg.query(
      `SELECT agent_id FROM fleet.conversations WHERE id = $1`,
      [conversationId]
    );
    const agentId = convR.rows[0]?.agent_id || null;

    // 4. Extract memories via Claude
    const extracted = await extractMemories(messages, anthropicKey);
    if (!extracted || extracted.length === 0) {
      console.log(`[chunker] conversation ${conversationId}: no memories extracted`);
      return { memoriesCreated: 0, chunksCreated: 0, embeddingsCreated: 0 };
    }

    let memoriesCreated = 0;
    let chunksCreated = 0;
    let embeddingsCreated = 0;

    // 5. Process each extracted memory
    for (const memory of extracted) {
      // a. Chunk the content
      const chunks = chunkText(memory.content);

      // b. Embed all chunks in one batch
      const vectors = await embedTexts(chunks, openaiKey);

      // c. Insert memory record
      const memR = await pg.query(
        `INSERT INTO fleet.memories (org_id, agent_id, content, summary, memory_type, salience, visibility, source_type, source_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'org', 'conversation', $7)
         RETURNING id`,
        [
          ORG_ID,
          agentId,
          memory.content,
          memory.summary || null,
          memory.memory_type || "long_term",
          memory.salience || 0.7,
          conversationId,
        ]
      );
      const memoryId = memR.rows[0].id;
      memoriesCreated++;

      // d. Insert chunks and embeddings
      for (let i = 0; i < chunks.length; i++) {
        const tokenCount = Math.ceil(chunks[i].length / 4);
        const chunkR = await pg.query(
          `INSERT INTO fleet.memory_chunks (memory_id, chunk_index, content, token_count)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [memoryId, i, chunks[i], tokenCount]
        );
        const chunkId = chunkR.rows[0].id;
        chunksCreated++;

        // Format vector as PostgreSQL array string
        const embeddingStr = "[" + vectors[i].join(",") + "]";
        await pg.query(
          `INSERT INTO fleet.memory_embeddings (chunk_id, embedding, embedding_model)
           VALUES ($1, $2::vector, $3)`,
          [chunkId, embeddingStr, "text-embedding-3-small"]
        );
        embeddingsCreated++;
      }

      // e. Process entities
      for (const entity of memory.entities || []) {
        // Upsert entity
        const entR = await pg.query(
          `INSERT INTO fleet.entities (org_id, entity_type, name)
           VALUES ($1, $2, $3)
           ON CONFLICT (org_id, name) DO UPDATE SET entity_type = EXCLUDED.entity_type
           RETURNING id`,
          [ORG_ID, entity.type || "other", entity.name]
        );
        const entityId = entR.rows[0].id;

        // Link entity to memory
        await pg.query(
          `INSERT INTO fleet.memory_entity_links (memory_id, entity_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [memoryId, entityId]
        );
      }
    }

    console.log(
      `[chunker] conversation ${conversationId}: extracted ${memoriesCreated} memories, ${chunksCreated} chunks, ${embeddingsCreated} embeddings`
    );
    return { memoriesCreated, chunksCreated, embeddingsCreated };
  } finally {
    await pg.end().catch(() => {});
  }
}

module.exports = { processConversation, chunkText, embedTexts };
