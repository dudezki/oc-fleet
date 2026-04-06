-- ============================================================
-- Fleet RAG — Complete Schema Migration
-- Project: Callbox Fleet RAG v2
-- Author: Lucky John Faderon
-- Date: 2026-04-02
-- Database: Supabase (ynlpbhtztwzdktfyguwq), ap-southeast-1
-- Schema: fleet
-- ============================================================
-- Run order: 01 → 02 → 02b → 02c → 03
-- Run against Supabase SQL Editor or psql with service role
-- ============================================================


-- ============================================================
-- 01_FOUNDATION: Schema, Extensions, Core Tables
-- ============================================================

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Create fleet schema
CREATE SCHEMA IF NOT EXISTS fleet;
GRANT USAGE ON SCHEMA fleet TO service_role, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA fleet TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA fleet GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA fleet GRANT SELECT ON TABLES TO anon, authenticated;

-- Organizations (top-level tenant)
CREATE TABLE fleet.organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Departments (within org)
CREATE TABLE fleet.departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES fleet.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(org_id, slug)
);

-- Agents (the bots)
CREATE TABLE fleet.agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES fleet.organizations(id) ON DELETE CASCADE,
    department_id UUID REFERENCES fleet.departments(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
    config JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(org_id, slug)
);

-- Users (humans interacting with agents)
CREATE TABLE fleet.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES fleet.organizations(id) ON DELETE CASCADE,
    external_id TEXT,
    platform TEXT,
    name TEXT,
    email TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(org_id, external_id, platform)
);

-- Entities (people, companies, projects)
CREATE TABLE fleet.entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES fleet.organizations(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'company', 'project', 'product', 'other')),
    name TEXT NOT NULL,
    aliases TEXT[],
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Foundation indexes
CREATE INDEX idx_fleet_departments_org ON fleet.departments(org_id);
CREATE INDEX idx_fleet_agents_org ON fleet.agents(org_id);
CREATE INDEX idx_fleet_agents_department ON fleet.agents(department_id);
CREATE INDEX idx_fleet_users_org ON fleet.users(org_id);
CREATE INDEX idx_fleet_users_external ON fleet.users(external_id, platform);
CREATE INDEX idx_fleet_entities_org ON fleet.entities(org_id);
CREATE INDEX idx_fleet_entities_type ON fleet.entities(org_id, entity_type);


-- ============================================================
-- 02_MEMORY: Memory Storage & Embeddings
-- ============================================================

-- Memories (main table)
CREATE TABLE fleet.memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES fleet.organizations(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES fleet.agents(id) ON DELETE SET NULL,
    user_id UUID REFERENCES fleet.users(id) ON DELETE SET NULL,
    memory_type TEXT NOT NULL CHECK (memory_type IN ('short_term', 'episodic', 'long_term', 'shared', 'knowledge')),
    content TEXT NOT NULL,
    summary TEXT,
    salience FLOAT DEFAULT 0.5,
    reliability FLOAT DEFAULT 1.0,
    access_count INT DEFAULT 0,
    last_accessed_at TIMESTAMPTZ,
    visibility TEXT DEFAULT 'private' CHECK (visibility IN ('private', 'department', 'org', 'cross_org')),
    department_id UUID REFERENCES fleet.departments(id) ON DELETE SET NULL,
    source_type TEXT,
    source_id UUID,
    expires_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Memory chunks (for long content)
CREATE TABLE fleet.memory_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id UUID NOT NULL REFERENCES fleet.memories(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    token_count INT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(memory_id, chunk_index)
);

-- Memory embeddings (pgvector 1536-dim)
CREATE TABLE fleet.memory_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id UUID REFERENCES fleet.memories(id) ON DELETE CASCADE,
    chunk_id UUID REFERENCES fleet.memory_chunks(id) ON DELETE CASCADE,
    embedding vector(768),
    embedding_model TEXT DEFAULT 'text-embedding-004',
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT embedding_target CHECK (
        (memory_id IS NOT NULL AND chunk_id IS NULL) OR
        (memory_id IS NULL AND chunk_id IS NOT NULL)
    )
);

-- Memory entity links
CREATE TABLE fleet.memory_entity_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id UUID NOT NULL REFERENCES fleet.memories(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES fleet.entities(id) ON DELETE CASCADE,
    relationship_type TEXT DEFAULT 'about',
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(memory_id, entity_id, relationship_type)
);

-- Memory links (relationships between memories)
CREATE TABLE fleet.memory_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_memory_id UUID NOT NULL REFERENCES fleet.memories(id) ON DELETE CASCADE,
    target_memory_id UUID NOT NULL REFERENCES fleet.memories(id) ON DELETE CASCADE,
    link_type TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(source_memory_id, target_memory_id, link_type)
);

-- Memory indexes
CREATE INDEX idx_fleet_memories_org ON fleet.memories(org_id);
CREATE INDEX idx_fleet_memories_agent ON fleet.memories(agent_id);
CREATE INDEX idx_fleet_memories_type ON fleet.memories(org_id, memory_type);
CREATE INDEX idx_fleet_memories_visibility ON fleet.memories(org_id, visibility);
CREATE INDEX idx_fleet_memories_expires ON fleet.memories(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_fleet_memories_deleted ON fleet.memories(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_fleet_chunks_memory ON fleet.memory_chunks(memory_id);
CREATE INDEX idx_fleet_embeddings_memory ON fleet.memory_embeddings(memory_id);
CREATE INDEX idx_fleet_embeddings_chunk ON fleet.memory_embeddings(chunk_id);
CREATE INDEX idx_fleet_embeddings_vector ON fleet.memory_embeddings
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_fleet_memory_entity_memory ON fleet.memory_entity_links(memory_id);
CREATE INDEX idx_fleet_memory_entity_entity ON fleet.memory_entity_links(entity_id);
CREATE INDEX idx_fleet_memory_links_source ON fleet.memory_links(source_memory_id);
CREATE INDEX idx_fleet_memory_links_target ON fleet.memory_links(target_memory_id);


-- ============================================================
-- 02b_CONVERSATIONS: Conversations & Messages
-- ============================================================

CREATE TABLE fleet.conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES fleet.organizations(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES fleet.agents(id) ON DELETE CASCADE,
    user_id UUID REFERENCES fleet.users(id) ON DELETE SET NULL,
    platform TEXT,
    platform_conversation_id TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'closed')),
    title TEXT,
    metadata JSONB DEFAULT '{}',
    started_at TIMESTAMPTZ DEFAULT now(),
    last_message_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(org_id, platform, platform_conversation_id)
);

CREATE TABLE fleet.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES fleet.conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    user_id UUID REFERENCES fleet.users(id) ON DELETE SET NULL,
    agent_id UUID REFERENCES fleet.agents(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    platform_message_id TEXT,
    reply_to_id UUID REFERENCES fleet.messages(id) ON DELETE SET NULL,
    metadata JSONB DEFAULT '{}',
    token_count INT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE fleet.conversation_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES fleet.conversations(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    from_message_id UUID REFERENCES fleet.messages(id),
    to_message_id UUID REFERENCES fleet.messages(id),
    message_count INT,
    token_count INT,
    model_used TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Conversation indexes
CREATE INDEX idx_fleet_conversations_org ON fleet.conversations(org_id);
CREATE INDEX idx_fleet_conversations_agent ON fleet.conversations(agent_id);
CREATE INDEX idx_fleet_conversations_user ON fleet.conversations(user_id);
CREATE INDEX idx_fleet_conversations_platform ON fleet.conversations(platform, platform_conversation_id);
CREATE INDEX idx_fleet_conversations_status ON fleet.conversations(org_id, status);
CREATE INDEX idx_fleet_conversations_last_msg ON fleet.conversations(last_message_at DESC);
CREATE INDEX idx_fleet_messages_conversation ON fleet.messages(conversation_id);
CREATE INDEX idx_fleet_messages_created ON fleet.messages(conversation_id, created_at);
CREATE INDEX idx_fleet_messages_platform ON fleet.messages(platform_message_id);
CREATE INDEX idx_fleet_messages_reply ON fleet.messages(reply_to_id);
CREATE INDEX idx_fleet_summaries_conversation ON fleet.conversation_summaries(conversation_id);


-- ============================================================
-- 02c_STATE: Session State, Tasks, Handoffs, Approvals
-- ============================================================

CREATE TABLE fleet.session_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES fleet.conversations(id) ON DELETE CASCADE,
    intent TEXT,
    stage TEXT,
    entities_extracted JSONB DEFAULT '{}',
    slots JSONB DEFAULT '{}',
    context JSONB DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(conversation_id)
);

CREATE TABLE fleet.tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES fleet.organizations(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES fleet.agents(id) ON DELETE SET NULL,
    user_id UUID REFERENCES fleet.users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'blocked', 'done', 'cancelled')),
    priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    due_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    source_message_id UUID REFERENCES fleet.messages(id) ON DELETE SET NULL,
    source_conversation_id UUID REFERENCES fleet.conversations(id) ON DELETE SET NULL,
    parent_task_id UUID REFERENCES fleet.tasks(id) ON DELETE SET NULL,
    recurrence_rule TEXT,
    next_occurrence_at TIMESTAMPTZ,
    tags TEXT[],
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE fleet.task_entity_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES fleet.tasks(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES fleet.entities(id) ON DELETE CASCADE,
    relationship_type TEXT DEFAULT 'about',
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(task_id, entity_id, relationship_type)
);

CREATE TABLE fleet.handoffs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES fleet.organizations(id) ON DELETE CASCADE,
    from_agent_id UUID NOT NULL REFERENCES fleet.agents(id) ON DELETE CASCADE,
    to_agent_id UUID NOT NULL REFERENCES fleet.agents(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES fleet.conversations(id) ON DELETE SET NULL,
    summary TEXT NOT NULL,
    current_state JSONB DEFAULT '{}',
    next_action TEXT,
    risks TEXT[],
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'completed')),
    memory_ids UUID[],
    accepted_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE fleet.approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES fleet.organizations(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES fleet.agents(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    action_payload JSONB NOT NULL,
    description TEXT,
    required_approver_id UUID REFERENCES fleet.users(id),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    decided_by UUID REFERENCES fleet.users(id),
    decision_reason TEXT,
    decided_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    conversation_id UUID REFERENCES fleet.conversations(id),
    message_id UUID REFERENCES fleet.messages(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- State indexes
CREATE INDEX idx_fleet_session_conversation ON fleet.session_state(conversation_id);
CREATE INDEX idx_fleet_tasks_org ON fleet.tasks(org_id);
CREATE INDEX idx_fleet_tasks_agent ON fleet.tasks(agent_id);
CREATE INDEX idx_fleet_tasks_user ON fleet.tasks(user_id);
CREATE INDEX idx_fleet_tasks_status ON fleet.tasks(org_id, status);
CREATE INDEX idx_fleet_tasks_due ON fleet.tasks(due_at) WHERE status IN ('pending', 'in_progress');
CREATE INDEX idx_fleet_tasks_parent ON fleet.tasks(parent_task_id);
CREATE INDEX idx_fleet_task_entity_task ON fleet.task_entity_links(task_id);
CREATE INDEX idx_fleet_task_entity_entity ON fleet.task_entity_links(entity_id);
CREATE INDEX idx_fleet_handoffs_org ON fleet.handoffs(org_id);
CREATE INDEX idx_fleet_handoffs_from ON fleet.handoffs(from_agent_id);
CREATE INDEX idx_fleet_handoffs_to ON fleet.handoffs(to_agent_id);
CREATE INDEX idx_fleet_handoffs_status ON fleet.handoffs(status);
CREATE INDEX idx_fleet_approvals_org ON fleet.approvals(org_id);
CREATE INDEX idx_fleet_approvals_agent ON fleet.approvals(agent_id);
CREATE INDEX idx_fleet_approvals_status ON fleet.approvals(status) WHERE status = 'pending';
CREATE INDEX idx_fleet_approvals_approver ON fleet.approvals(required_approver_id) WHERE status = 'pending';
CREATE INDEX idx_fleet_approvals_expires ON fleet.approvals(expires_at) WHERE status = 'pending';


-- ============================================================
-- 03_RETRIEVAL_FUNCTIONS: PL/pgSQL Query Functions
-- ============================================================

-- 1. Semantic memory search
CREATE OR REPLACE FUNCTION fleet.search_memories(
    p_org_id UUID,
    p_query_embedding vector(768),
    p_memory_types TEXT[] DEFAULT NULL,
    p_agent_id UUID DEFAULT NULL,
    p_visibility TEXT[] DEFAULT ARRAY['private', 'department', 'org'],
    p_limit INT DEFAULT 10,
    p_similarity_threshold FLOAT DEFAULT 0.7
) RETURNS TABLE (
    memory_id UUID, content TEXT, summary TEXT, memory_type TEXT,
    similarity FLOAT, salience FLOAT, created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT m.id, m.content, m.summary, m.memory_type,
        1 - (e.embedding <=> p_query_embedding),
        m.salience, m.created_at
    FROM fleet.memories m
    JOIN fleet.memory_embeddings e ON e.memory_id = m.id
    WHERE m.org_id = p_org_id AND m.deleted_at IS NULL
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND (p_memory_types IS NULL OR m.memory_type = ANY(p_memory_types))
      AND (p_agent_id IS NULL OR m.agent_id = p_agent_id OR m.visibility != 'private')
      AND m.visibility = ANY(p_visibility)
      AND 1 - (e.embedding <=> p_query_embedding) >= p_similarity_threshold
    ORDER BY e.embedding <=> p_query_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- 2. Hybrid scored retrieval
CREATE OR REPLACE FUNCTION fleet.search_memories_scored(
    p_org_id UUID,
    p_query_embedding vector(768),
    p_agent_id UUID DEFAULT NULL,
    p_memory_types TEXT[] DEFAULT NULL,
    p_limit INT DEFAULT 10,
    p_weight_semantic FLOAT DEFAULT 0.35,
    p_weight_recency FLOAT DEFAULT 0.25,
    p_weight_salience FLOAT DEFAULT 0.25,
    p_weight_reliability FLOAT DEFAULT 0.15
) RETURNS TABLE (
    memory_id UUID, content TEXT, memory_type TEXT, final_score FLOAT,
    semantic_score FLOAT, recency_score FLOAT, salience FLOAT,
    reliability FLOAT, created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT m.id, m.content, m.memory_type,
        (p_weight_semantic * (1 - (e.embedding <=> p_query_embedding)) +
         p_weight_recency * (1 - LEAST(EXTRACT(EPOCH FROM (now() - m.created_at)) / 2592000, 1)) +
         p_weight_salience * m.salience +
         p_weight_reliability * m.reliability),
        1 - (e.embedding <=> p_query_embedding),
        1 - LEAST(EXTRACT(EPOCH FROM (now() - m.created_at)) / 2592000, 1),
        m.salience, m.reliability, m.created_at
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
$$ LANGUAGE plpgsql;

-- 3. Touch memory (update access stats)
CREATE OR REPLACE FUNCTION fleet.touch_memory(p_memory_id UUID) RETURNS VOID AS $$
BEGIN
    UPDATE fleet.memories
    SET access_count = access_count + 1, last_accessed_at = now()
    WHERE id = p_memory_id;
END;
$$ LANGUAGE plpgsql;

-- 4. Get recent memories
CREATE OR REPLACE FUNCTION fleet.get_recent_memories(
    p_org_id UUID, p_agent_id UUID,
    p_memory_types TEXT[] DEFAULT ARRAY['short_term', 'episodic'],
    p_hours INT DEFAULT 24, p_limit INT DEFAULT 20
) RETURNS TABLE (
    memory_id UUID, content TEXT, memory_type TEXT, salience FLOAT, created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT m.id, m.content, m.memory_type, m.salience, m.created_at
    FROM fleet.memories m
    WHERE m.org_id = p_org_id AND m.agent_id = p_agent_id
      AND m.memory_type = ANY(p_memory_types) AND m.deleted_at IS NULL
      AND m.created_at > now() - (p_hours || ' hours')::INTERVAL
    ORDER BY m.created_at DESC LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- 5. Find entity by name
CREATE OR REPLACE FUNCTION fleet.find_entity(
    p_org_id UUID, p_name TEXT, p_entity_type TEXT DEFAULT NULL
) RETURNS TABLE (entity_id UUID, name TEXT, entity_type TEXT, match_type TEXT) AS $$
BEGIN
    RETURN QUERY
    SELECT e.id, e.name, e.entity_type, 'exact'::TEXT
    FROM fleet.entities e
    WHERE e.org_id = p_org_id AND LOWER(e.name) = LOWER(p_name)
      AND (p_entity_type IS NULL OR e.entity_type = p_entity_type)
    UNION ALL
    SELECT e.id, e.name, e.entity_type, 'alias'::TEXT
    FROM fleet.entities e
    WHERE e.org_id = p_org_id AND LOWER(p_name) = ANY(SELECT LOWER(unnest(e.aliases)))
      AND (p_entity_type IS NULL OR e.entity_type = p_entity_type)
    LIMIT 5;
END;
$$ LANGUAGE plpgsql;

-- 6. Get conversation context
CREATE OR REPLACE FUNCTION fleet.get_conversation_context(
    p_conversation_id UUID, p_message_limit INT DEFAULT 20
) RETURNS TABLE (context_type TEXT, content TEXT, role TEXT, created_at TIMESTAMPTZ) AS $$
BEGIN
    RETURN QUERY
    SELECT 'summary'::TEXT, cs.summary, 'system'::TEXT, cs.created_at
    FROM fleet.conversation_summaries cs
    WHERE cs.conversation_id = p_conversation_id
    ORDER BY cs.created_at DESC LIMIT 1;

    RETURN QUERY
    SELECT 'message'::TEXT, m.content, m.role, m.created_at
    FROM fleet.messages m
    WHERE m.conversation_id = p_conversation_id
    ORDER BY m.created_at DESC LIMIT p_message_limit;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- SEED DATA — Callbox Fleet RAG Org & Agents
-- ============================================================

INSERT INTO fleet.organizations (id, name, slug)
VALUES ('f86d92cb-db10-43ff-9ff2-d69c319d272d', 'Callbox', 'callbox')
ON CONFLICT (id) DO NOTHING;

INSERT INTO fleet.agents (id, org_id, name, slug, status) VALUES
    ('83e429b5-60fb-4cf4-8113-599f96b59ab5', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', 'RAG-Main', 'rag', 'active'),
    ('b81c0d8a-3f76-43fe-b2e5-2537801085dc', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', 'Fleet-Sales', 'sales', 'active'),
    ('325e5143-3c0b-4d65-b548-a34cbdba5949', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', 'Fleet-Support', 'support', 'active'),
    ('82061d1c-2c79-4cfb-9e18-b8233b95a7c2', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', 'Fleet-Manager', 'manager', 'active')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- END OF MIGRATION
-- ============================================================
