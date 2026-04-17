#!/bin/bash
# Migration handoff — scheduled by Lucky John Faderon for 1PM PHT Apr 13 2026

ORG_ID="f86d92cb-db10-43ff-9ff2-d69c319d272d"
PROXY="http://127.0.0.1:20000/fleet-api/tasks/create"

TITLE="[Scheduled by Lucky · 1PM PHT] Memory, Skills & Knowledge Migration — Fleet v1 → Fleet v2"

BODY="Hey team,

This is a scheduled handoff from Lucky outlining the migration plan for memories, skills, and knowledge from Fleet v1 (@CallboxAI_bot) into Fleet v2.

---

📦 WHAT WE'RE MIGRATING
• Agent memories (long-term, episodic, org-wide)
• Skill definitions + assignments
• Knowledge base chunks + embeddings

---

🤖 THE SETUP — Two-Agent Approach

| Role | Agent | Task |
| Extraction | @CallboxAI_bot (Fleet v1) | Pull existing memories, skills, knowledge from v1 |
| Ingestion & Maintenance | Cal (Fleet v2) | Ingest, clean, re-embed, and maintain in Fleet v2 DB |

---

📌 DATA BINDING — SHARED vs SPECIFIC

Classify ALL data before migrating:

• Org-wide shared — agent_id = NULL, visibility = org → Company policies, product knowledge, SOPs
• Agent-specific — agent_id set, visibility = agent → Agent personality notes, role instructions
• Skill (shared) — No agent assignment → Available to any agent via skills/match
• Skill (specific) — Assigned to specific agents → Only matched for assigned agents
• Knowledge (org scope) — scope: org → Searchable by all agents via RAG
• Knowledge (agent scope) — scope: agent → Scoped to one agent's RAG context
• Memory (long_term) — High-salience, persists across sessions → Key client info, decisions
• Memory (episodic) — Contextual, session-relevant → Summaries, action items per convo

⚠️ HARD RULE: Do NOT migrate agent-specific memories as org-wide. Check visibility and agent_id in v1 before ingesting. Wrong binding = data leaking to the wrong agents.

---

🔄 MIGRATION FLOW

1. EXTRACT from v1 via @CallboxAI_bot
   • Export agent memories per org/agent — note agent_id and visibility on each record
   • Export skill definitions + instructions — note which agents they are assigned to
   • Export knowledge chunks with scope and domain metadata

2. INGEST into v2 via Cal
   • Shared memories → POST /fleet-api/store with agent_id: null, visibility: org
   • Agent-specific memories → POST /fleet-api/store with correct agent_id, visibility: agent
   • Org knowledge → /fleet-api/knowledge/upsert with scope: org
   • Agent knowledge → /fleet-api/knowledge/upsert with scope: agent + agent_id
   • Skills → Create in Nexus, assign to specific agents if agent-specific, leave unassigned if shared
   • Re-embed all skills via reembed script after creation

3. VALIDATE
   • Run skills/match test queries per agent to confirm correct scoping
   • Spot-check RAG results — confirm org knowledge doesn't bleed into wrong agent contexts
   • Verify agent-specific memories aren't visible org-wide

---

🔧 ONGOING MAINTENANCE (via Cal)
• New skills → create in Nexus, Cal re-embeds on request
• Memory pruning → Cal can purge stale/duplicate entries on command
• Knowledge updates → Cal ingests via knowledge/upsert, auto-embeds
• Binding audits → Cal can query DB to surface any mis-scoped data

---

✅ ACTION ITEMS

Fleet-Dev → Provide v1 export scripts/endpoints; flag any records with ambiguous binding
Fleet-Support → Identify client-specific knowledge that should stay agent-scoped vs shared
Fleet-Manager → Confirm org scope, priority order, and sign off on what gets migrated as shared

Questions → ping Cal directly.

— Lucky"

for AGENT_ID in "87a2838e-e145-4f5c-99e2-c759f0591cba" "325e5143-3c0b-4d65-b548-a34cbdba5949" "82061d1c-2c79-4cfb-9e18-b8233b95a7c2"; do
  curl -s -X POST "$PROXY" \
    -H "Content-Type: application/json" \
    -d "{
      \"org_id\": \"$ORG_ID\",
      \"agent_id\": \"$AGENT_ID\",
      \"title\": \"$TITLE\",
      \"description\": $(echo "$BODY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
      \"priority\": \"high\",
      \"tags\": [\"migration\", \"handoff\", \"scheduled\", \"lucky\"]
    }"
  echo ""
done

openclaw system event --text "✅ Migration handoff sent to Fleet-Dev, Fleet-Support, Fleet-Manager (scheduled 1PM PHT)" --mode now
