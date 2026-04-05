DROP FUNCTION IF EXISTS fleet.search_memories_scored CASCADE;

CREATE OR REPLACE FUNCTION fleet.search_memories_scored(
  p_org_id UUID,
  p_query_embedding vector(768),
  p_limit INT DEFAULT 10,
  p_agent_id UUID DEFAULT NULL,
  p_memory_types TEXT[] DEFAULT NULL,
  p_weight_semantic FLOAT DEFAULT 0.35,
  p_weight_recency FLOAT DEFAULT 0.25,
  p_weight_salience FLOAT DEFAULT 0.25,
  p_weight_reliability FLOAT DEFAULT 0.15
)
RETURNS TABLE(
  id UUID,
  content TEXT,
  memory_type TEXT,
  combined_score FLOAT,
  semantic_score FLOAT,
  recency_score FLOAT,
  salience FLOAT,
  reliability FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.memory_type,
    (p_weight_semantic * (1 - (e.embedding <=> p_query_embedding)) +
     p_weight_recency * (1 - LEAST(EXTRACT(EPOCH FROM (now() - m.created_at)) / 2592000, 1)) +
     p_weight_salience * m.salience +
     p_weight_reliability * m.reliability)::FLOAT,
    (1 - (e.embedding <=> p_query_embedding))::FLOAT,
    (1 - LEAST(EXTRACT(EPOCH FROM (now() - m.created_at)) / 2592000, 1))::FLOAT,
    m.salience::FLOAT,
    m.reliability::FLOAT,
    m.created_at
  FROM fleet.memories m
  JOIN fleet.memory_embeddings e ON e.memory_id = m.id
  WHERE m.org_id = p_org_id AND m.deleted_at IS NULL
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND (p_memory_types IS NULL OR m.memory_type = ANY(p_memory_types))
    AND (p_agent_id IS NULL OR m.agent_id = p_agent_id OR m.visibility != 'private')
  ORDER BY (
    p_weight_semantic * (1 - (e.embedding <=> p_query_embedding)) +
    p_weight_recency * (1 - LEAST(EXTRACT(EPOCH FROM (now() - m.created_at)) / 2592000, 1)) +
    p_weight_salience * m.salience + p_weight_reliability * m.reliability
  ) DESC
  LIMIT p_limit;
END;
$$;

SELECT 'search_memories_scored recreated' as status;
