-- ============================================================
-- Fleet Sessions — Session Grouping Migration
-- Project: OpenClaw Fleet RAG
-- Author: Lucky John Faderon
-- Date: 2026-04-05
-- Schema: fleet
-- Run after fleet-rag-schema-migration.sql
-- ============================================================

-- fleet.sessions table
CREATE TABLE IF NOT EXISTS fleet.sessions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_number    BIGSERIAL UNIQUE,
    org_id            UUID NOT NULL REFERENCES fleet.organizations(id) ON DELETE CASCADE,
    agent_id          UUID NOT NULL REFERENCES fleet.agents(id) ON DELETE CASCADE,
    user_id           UUID REFERENCES fleet.users(id) ON DELETE SET NULL,  -- NULL for GC
    platform_chat_id  TEXT NOT NULL,
    chat_type         TEXT NOT NULL DEFAULT 'direct' CHECK (chat_type IN ('direct', 'group')),
    started_at        TIMESTAMPTZ DEFAULT now(),
    ended_at          TIMESTAMPTZ,
    summary           TEXT,
    reset_by          TEXT CHECK (reset_by IN ('user', 'admin', 'agent', 'timeout')),
    reset_by_user_id  UUID REFERENCES fleet.users(id) ON DELETE SET NULL,
    metadata          JSONB DEFAULT '{}',
    created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fleet_sessions_org ON fleet.sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_fleet_sessions_agent_chat ON fleet.sessions(agent_id, platform_chat_id);
CREATE INDEX IF NOT EXISTS idx_fleet_sessions_user ON fleet.sessions(user_id);

-- Add session_id to conversations (conversations belong to a session)
ALTER TABLE fleet.conversations
    ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES fleet.sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fleet_conversations_session ON fleet.conversations(session_id);
