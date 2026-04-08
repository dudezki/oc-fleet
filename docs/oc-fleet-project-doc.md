# Callbox Fleet (oc-fleet) — Project Documentation
> Generated: April 7, 2026 | For: NotebookLM / Presentation

---

## 1. Executive Summary

**Callbox Fleet** is an AI-powered multi-agent system built on top of OpenClaw. It deploys specialized AI agents (Sales, Support, HR, Finance, Dev, IT, Manager, Documentor) that interact with employees via Telegram. Each agent is scoped to a department, integrated with HubSpot CRM and Google Workspace, and managed through a central dashboard called **Nexus**.

The system is designed to give every employee access to a smart, department-aware AI assistant — without exposing internal infrastructure or sensitive data.

---

## 2. Infrastructure

### Deployment
- **Server:** Proxmox LXC at `192.168.50.40` (LAN) / `222.127.137.7` (WAN)
- **Public URL:** https://oc.callboxinc.ai
- **Dashboard (Nexus):** https://oc.callboxinc.ai/dashboard
- **Runtime:** Node.js v24 on Ubuntu (Proxmox LXC)
- **Database:** PostgreSQL 16 + pgvector on port 5433
- **AI Platform:** OpenClaw (self-hosted) + Anthropic Claude (claude-sonnet-4-6)

### Port Map
| Service | Port |
|---|---|
| Central Proxy | 20000 |
| Fleet-Sales | 20010 |
| Fleet-Support | 20020 |
| Fleet-Manager | 20030 |
| Fleet-Dev | 20040 |
| Fleet-IT | 20050 |
| Fleet-HR | 20060 |
| Fleet-Finance | 20070 |
| Fleet-Documentor | 20090 |
| Nexus Dashboard | 20099 |
| Google Auth Proxy | 19001 |
| HubSpot OAuth | 19002 |
| HubSpot Proxy | 19003 |

---

## 3. System Architecture

### Components

```
User (Telegram)
      ↓
OpenClaw Gateway (per agent)
      ↓
Agent (Claude claude-sonnet-4-6)
      ↓
Central Proxy (:20000) — fleet-api
      ↓
PostgreSQL (fleet schema) + pgvector
      ↓
External APIs (HubSpot, Google, Datamine)
```

### Key Subsystems

**Central Proxy (`proxy/server.js`)**
- Single entry point for all fleet API calls
- Handles: pairing, sessions, RAG search, memory, handoffs, tasks, skills, conversations, knowledge
- All agents call `http://127.0.0.1:20000/fleet-api/<fn>`

**HubSpot Proxy (`hubspot-proxy/server.js`, port 19003)**
- Per-user identity resolution (email → HubSpot owner ID)
- CRM search, write, reports, lead qualification
- Portals: MarketingCRM (4950628), OneCRM (21203560)

**Google Auth Proxy (`google-auth-proxy/server.js`, port 19001)**
- OAuth 2.0 flow for Google Workspace
- Handles: Docs, Sheets, Slides, Drive, Gmail, Calendar
- Tokens stored in `fleet.user_integrations`

**HubSpot OAuth (`hubspot-oauth/server.js`, port 19002)**
- Per-user HubSpot authentication
- Role-based portal access

**Nexus Dashboard (`dashboard/server.js`, port 20099)**
- Web UI for fleet management
- Pages: Agents, Accounts, Skills, Sessions, Handoffs, Tasks, Memories, Reports, Settings
- Real-time WebSocket updates

---

## 4. Agent Roster

| Agent | Role | Skills |
|---|---|---|
| Fleet-Sales | Lead qualification, CRM, proposals, pipeline | 50 |
| Fleet-Support | Customer support, escalations | 47 |
| Fleet-Manager | Org-wide oversight, broadcasts, admin | 54 |
| Fleet-Dev | Engineering, feature requests, bug fixes | 48 |
| Fleet-IT | Infrastructure, system access | 47 |
| Fleet-HR | HR operations, onboarding, people ops | 48 |
| Fleet-Finance | Finance, reporting, expenses | 47 |
| Fleet-Documentor | Documentation, knowledge base | 31 |

All agents run on OpenClaw with Claude claude-sonnet-4-6 and connect to Telegram via dedicated bot tokens.

---

## 5. How Agents Work — Protocol

Every fleet agent follows a strict 4-step protocol on every user message:

### Step 1 — Pairing Check
```
POST /fleet-api/pairing/check
{ telegram_id, org_id, agent_id, message, message_id }
```
- Verifies the user's Telegram account is linked to a Callbox account
- If not paired → runs OTP email verification flow
- If paired → returns user profile (name, email, role, department, permissions)

### Step 2 — RAG Lookup
- Searches vector memory for relevant context
- Uses `gemini-embedding-004` embeddings stored in pgvector
- Results inform the agent's response

### Step 3 — On-Demand Skill Matching *(new as of Apr 7, 2026)*
```
POST /fleet-api/skills/match
{ fn: "skills/match", query: "<user intent>", agent: "<slug>" }
```
- Vector search against `fleet.skills.description_embedding`
- Returns best-match skill with full instructions + API endpoint
- Confidence threshold: 0.65
- If match found → agent asks user confirmation before executing
- If no match → agent responds from base knowledge

### Step 4 — Store Memory
- Meaningful interactions stored to `fleet.memories` via `/fleet-api/store`
- Episodic and long-term memory types

---

## 6. Skills System

### Overview
67 active skills stored in `fleet.skills` database table. Skills are:
- **DB-driven** — managed via Nexus dashboard, no file deployment needed
- **Embedded** — each skill has a `description_embedding vector(3072)` for RAG matching
- **Assigned** — each agent has a specific subset of skills via `fleet.agent_skill_assignments`

### Skill Categories

**Memory & RAG**
- `memory.search` — semantic search across fleet memories
- `memory.store` — store facts and events
- `memory.view` — view stored memories
- `fleet-rag` — store/retrieve fleet knowledge + handoffs

**Handoffs & Tasks**
- `handoff.create` — escalate to another agent
- `handoff.accept` — accept incoming handoffs
- `handoff.deny` — reject handoffs
- `handoff.view` — view handoff history
- `task.create` / `task.view` / `task.update` / `task.delete` — task management

**HubSpot CRM (12 agents assigned)**
- `hubspot.auth` — OAuth flow per user
- `hubspot.search` — search contacts, companies, deals
- `hubspot.write` — create/update CRM records
- `hubspot.report` — predefined scoped reports
- `hubspot.dynamic_list` — campaign-ready prospect lists
- `hubspot.identity` — resolve user's HubSpot identity
- `hubspot.object.search` — custom object search
- `lead-qualification` — FAINT scoring (0–100) for leads

**Google Workspace (10 agents, 23 skills)**
- Auth: `google.auth`, `google.auth.status`, `google.auth.disconnect`
- Docs: create, read, update, delete
- Sheets: create, read, write, delete
- Slides: create, read, delete
- Drive: list, upload, delete, share
- Gmail: send, read inbox
- Calendar: list, create, delete

**Conversations & Accounts**
- `conversation.view` — user's own conversation history
- `conversation.all` — org-wide conversations (admin)
- `accounts.view` / `accounts.manage` — account management

**Sales-Specific**
- `lead-qualification` — FAINT framework lead scoring
- `datamine` — prospect database query (192.168.50.34)
- `hubspot-queries` — deal forecasts, meeting percentages, lead counts

**Org Management**
- `org-broadcast` — org-wide or department announcements
- `read-broadcast` — receive broadcast notifications
- `reports.fleet` — org-wide analytics

---

## 7. On-Demand Skill Matching — Technical Deep Dive

### The Problem (Before)
Agents preloaded their full assigned skill list at startup:
- Every skill's name, description, instructions, and endpoints loaded into context
- Context window bloat: 50+ skills × average 200 tokens = ~10,000 tokens per session just for skills
- Skills loaded even if never used

### The Solution (After — Apr 7, 2026)
On-demand RAG-based skill matching:

**Embedding Layer**
- Each skill's `name + description` embedded using `gemini-embedding-001` (3072 dimensions)
- Stored in `fleet.skills.description_embedding vector(3072)`
- 67 skills embedded

**Matching Flow**
```
User message arrives
      ↓
Agent distills intent into a short query
      ↓
POST /fleet-api/skills/match { query, agent }
      ↓
Proxy embeds query via Gemini API
      ↓
pgvector cosine similarity against agent's assigned skills only
      ↓
Returns top match if confidence ≥ 0.65
      ↓
Agent presents: "I can run [Skill Name] — [what it does]. Want me to go ahead?"
      ↓
User confirms → Agent executes using match.api_endpoint + match.instructions
```

**Result**
- Zero skills in context at startup
- Only the relevant skill's instructions loaded when needed
- User confirmation gate before any skill execution
- Context stays lean regardless of how many skills are assigned

---

## 8. Identity & Access Control

### Account Structure
- Accounts stored in `fleet.accounts`
- Fields: email, name, role, department, permissions (JSONB), is_active

### Roles
| Role | Access |
|---|---|
| `admin` | Full cross-department access to all agents |
| `team_lead` | Department-wide access |
| `member` | Own data only |

### Pairing Flow (OTP)
1. User messages bot → pairing check runs
2. If unbound → bot asks for Callbox email
3. OTP sent via email (Resend)
4. User enters 6-digit code
5. Bot verifies → creates `fleet.telegram_bindings` record
6. User is now paired and can use all their assigned skills

### Admin Bypass Rule
Users with `role = "admin"` are never blocked or redirected regardless of which agent they're talking to or what department they belong to. This is enforced at both the proxy level (in `pairing/check` response) and explicitly stated in every agent's system prompt.

---

## 9. Database Schema (Key Tables)

| Table | Purpose |
|---|---|
| `fleet.agents` | Agent registry (slug, name, ports, bot tokens) |
| `fleet.accounts` | User accounts (email, role, department, permissions) |
| `fleet.telegram_bindings` | Telegram ID ↔ account mappings |
| `fleet.skills` | Skill definitions (instructions, api_endpoint, embeddings) |
| `fleet.agent_skill_assignments` | Which skills each agent has |
| `fleet.conversations` | Conversation sessions per agent per user |
| `fleet.messages` | Individual messages with token/cost tracking |
| `fleet.memories` | Vector-embedded memory entries |
| `fleet.handoffs` | Agent-to-agent handoff records |
| `fleet.sessions` | Named user sessions per agent |
| `fleet.tasks` | Task assignments |
| `fleet.knowledge` | Org-wide RAG knowledge base |
| `fleet.agent_configs` | System prompts and protocols (global + per-agent) |
| `fleet.user_integrations` | OAuth tokens (Google, HubSpot) per user |
| `fleet.otp_verifications` | OTP pairing codes |
| `fleet.gc_pairings` | Group chat pairing state |
| `fleet.gc_bindings` | Group chat ↔ account mappings |

---

## 10. Nexus Dashboard

**URL:** https://oc.callboxinc.ai/dashboard (basic auth: nexus / Fleet@2026!)

### Pages
- **/agents** — Live agent status, start/stop/restart, model/provider config
- **/accounts** — User accounts, bindings, activity
- **/skills** — Skill CRUD, agent assignment, callbacks
- **/sessions** — All user sessions across fleet
- **/handoffs** — Cross-agent handoff tracking
- **/tasks** — Task management
- **/memories** — Fleet memory browser
- **/reports** — Cost tracking, token usage, fleet analytics
- **/settings** — Global protocol editor, provider defaults

---

## 11. Session Sync

A background worker (`scripts/sync-sessions.js`) runs every 2 minutes via cron:
- Reads OpenClaw JSONL session files for all agents
- Extracts messages, token usage, cost data
- Syncs to `fleet.messages` and `fleet.conversations`
- Filters out heartbeat noise and internal metadata
- Tracks assistant message context via rolling conversation state

---

## 12. What Was Built — April 7, 2026

### On-Demand Skill Matching (Major Feature)
- Added `description_embedding vector(3072)` to `fleet.skills`
- Embedded all 67 active skills using `gemini-embedding-001`
- Built `skills/match` RAG endpoint in central proxy
- Updated global agent protocol to remove upfront `skills/list`
- Updated all agent SOUL.md files to remove startup skill loading
- **Result:** Agents now match skills dynamically — zero startup context cost

### Admin Bypass Fix
- Found that per-agent SOUL.md guardrails were blocking admin users at the department level
- Updated `fleet-routing` skill instructions to exempt `role=admin` users
- Added explicit admin bypass rule to all 7 per-agent DB configs
- **Result:** Admin users now bypass all department restrictions on all bots

### HubSpot Proxy Enhancements
- DB-first identity resolution (checks `fleet.user_integrations` before routing table)
- `/qualify` endpoint: FAINT lead scoring (FIT+INTEREST+AUTHORITY+NEED+TIMELINE+COMPETITOR)
- URL parsing: accepts HubSpot browser URLs directly (app.hubspot.com and app-na2.hubspot.com)
- Routing table seeded with Brian and Lucky

---

## 13. Known Issues / Pending

| Item | Status |
|---|---|
| `callbox-onboarding` skill points to Joe's Mac path | ⚠️ Needs LXC path fix |
| `fleet-routing` skill points to Joe's Mac path | ⚠️ Needs LXC path fix |
| `transcript-scorer` — Mac path + no agent assigned | ⚠️ Needs rebuild |
| `bigbox-platform`, `ld-video-creator`, `funnel-target-fixer` — no endpoints | ⚠️ Backend not built |
| Resend email domain verification (callboxinc.com) | ⚠️ Pending |
| GitHub push credentials on LXC | ⚠️ No SSH/token set up |
| Security agent (port 20080) | ❌ Down |
| Pipeline stage ID mapping for FAINT Need scoring | ⚠️ Pending |
| Transcript Scorer skill rebuild | ⚠️ Pending |

---

## 14. Tech Stack Summary

| Layer | Technology |
|---|---|
| AI Runtime | OpenClaw (self-hosted) |
| LLM | Anthropic Claude claude-sonnet-4-6 |
| Embeddings | Google Gemini `gemini-embedding-001` (3072-dim) |
| Vector Search | pgvector (PostgreSQL extension) |
| Database | PostgreSQL 16 |
| Backend | Node.js v24 |
| Channel | Telegram (per-bot tokens) |
| CRM | HubSpot (MarketingCRM + OneCRM) |
| Productivity | Google Workspace (OAuth 2.0) |
| Dashboard | Express.js + WebSockets |
| Infrastructure | Proxmox LXC, nginx, Let's Encrypt SSL |
| Email | Resend (transactional) |

---

*Document generated from live system state — April 7, 2026*
*Org: Callbox Inc. | Project: oc-fleet | Maintained by: Lucky Faderon (Lead AI Engineer)*
