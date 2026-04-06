-- ============================================================
-- Fleet Handoff Worker — Schema Migration
-- Adds fields needed for the handoff delivery worker
-- Run after fleet-rag-schema-migration.sql + sessions-migration.sql
-- ============================================================

-- Add delivery tracking columns to fleet.handoffs
ALTER TABLE fleet.handoffs
  ADD COLUMN IF NOT EXISTS target_type    TEXT DEFAULT 'user'
    CHECK (target_type IN ('user', 'agent', 'department', 'org')),
  ADD COLUMN IF NOT EXISTS target_session_id UUID REFERENCES fleet.sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS telegram_id    TEXT,                   -- user to notify (for user-targeted)
  ADD COLUMN IF NOT EXISTS notified_at    TIMESTAMPTZ,            -- when worker delivered it
  ADD COLUMN IF NOT EXISTS notified_agents JSONB DEFAULT '[]',    -- [{ agent_id, port, notified_at }]
  ADD COLUMN IF NOT EXISTS delivery_error TEXT;                   -- last error if delivery failed

-- Index for worker query (pending + unnotified)
CREATE INDEX IF NOT EXISTS idx_fleet_handoffs_worker
  ON fleet.handoffs(status, notified_at)
  WHERE status = 'pending' AND notified_at IS NULL;

-- agent_configs: store gateway port + token per agent for worker lookups
-- (agents table gets a config column if not already there)
ALTER TABLE fleet.agents
  ADD COLUMN IF NOT EXISTS gateway_port  INT,
  ADD COLUMN IF NOT EXISTS gateway_token TEXT;

-- Seed known agent gateway configs (update tokens as needed)
-- These will be overridden by the worker's .env or DB lookup
COMMENT ON COLUMN fleet.agents.gateway_port  IS 'OpenClaw gateway port for this agent instance';
COMMENT ON COLUMN fleet.agents.gateway_token IS 'OpenClaw gateway auth token for system event injection';

-- Unify gateway_token + hooks_token (2026-04-06)
-- hooks_token is the single token used for both OC gateway auth AND handoff worker delivery
ALTER TABLE fleet.agents ADD COLUMN IF NOT EXISTS hooks_token TEXT;
UPDATE fleet.agents SET hooks_token = gateway_token WHERE hooks_token IS NULL AND gateway_token IS NOT NULL;
COMMENT ON COLUMN fleet.agents.hooks_token IS 'Unified auth token — used for OpenClaw gateway auth AND handoff worker delivery. Always equals gateway_token.';
