# Skill System Changes — April 7, 2026

## Summary

Migrated fleet agents from **full upfront skill loading** to **on-demand RAG-based skill matching**. This reduces agent context bloat, improves response intent-alignment, and enables a user-confirmation gate before skill execution.

---

## What Changed

### Before
1. Agent startup → `POST /fleet-api/skills/list` with agent_id
2. All assigned skills (50+) loaded into context: slug, name, description, instructions, api_endpoint
3. Agent decides which skill to use based on full context
4. Skills executed silently or with minimal user awareness

### After
1. Agent startup → `POST /fleet-api/agent/config` only (no skills/list)
2. Per message → agent distills user intent → `POST /fleet-api/skills/match { query, agent }`
3. Proxy returns best-match skill (confidence ≥ 0.65) with full instructions
4. Agent presents: *"I can run **[Skill Name]** — [plain description]. Want me to go ahead?"*
5. User confirms → agent executes using `match.api_endpoint` + `match.instructions`
6. No match → agent responds from base knowledge

---

## New Endpoint: `skills/match`

**Request:**
```json
POST http://127.0.0.1:20000/fleet-api/skills/match
{
  "fn": "skills/match",
  "query": "qualify this lead from HubSpot",
  "agent": "sales"
}
```

**Response (match found):**
```json
{
  "match": {
    "slug": "lead-qualification",
    "name": "Lead Qualification",
    "description": "Score leads 0-100 using FAINT framework...",
    "api_endpoint": "http://127.0.0.1:19003/qualify",
    "api_method": "POST",
    "instructions": "Score leads 0-100 using FAINT: FIT(30%)...",
    "confidence": 0.7334
  }
}
```

**Response (no match):**
```json
{
  "match": null,
  "confidence": 0.42,
  "reason": "no confident match"
}
```

**Parameters:**
| Param | Required | Description |
|---|---|---|
| `query` | Yes | Short description of user intent |
| `agent` | No | Agent slug — scopes search to assigned skills only |

**Confidence threshold:** 0.65 (cosine similarity)

---

## Database Changes

### New Column
```sql
ALTER TABLE fleet.skills
ADD COLUMN description_embedding vector(3072);
```

### Embedding Model
- Model: `gemini-embedding-001` (Google Gemini)
- Dimensions: 3072 (native, no truncation)
- Input text: `"${skill.name}: ${skill.description}"`
- All 67 active skills embedded

### Re-embedding Script
```bash
node /home/dev-user/Projects/oc-fleet/scripts/embed-skills.js
```

Run this whenever:
- New skills are added
- Skill names or descriptions are updated
- Embedding model changes

---

## Agent Protocol Changes

### Global Protocol (`fleet.agent_configs` where `agent_id IS NULL`)

**Removed from Section 1 (Startup):**
```
POST /fleet-api/skills/list
{ org_id, agent_id }
→ Load and remember all skills
```

**Added to Section 2 (Every Message) as Step 3:**
```
POST /fleet-api/skills/match
{ fn: "skills/match", query: "<intent>", agent: "{{AGENT_SLUG}}" }
→ If match (confidence ≥ 0.65): ask user confirmation
→ On confirm: execute using match.api_endpoint + match.instructions
→ No match: respond normally
```

**Silent skills (no confirmation needed):**
- `memory.search`, `fleet-rag`, `memory.store`, `pairing/check`

### SOUL.md Changes (All Agents)
Replaced in all agent SOUL.md files:
```markdown
### Skills assigned to this agent
[curl skills/list block]
Load and remember these skills...
```

With:
```markdown
### Skills — On-Demand Only
**Do NOT fetch skills at startup.** Skills are matched on-demand per message
via `skills/match`. See the protocol loaded from `agent/config` for full instructions.
```

Files updated:
- `/home/dev-user/cbfleet-rag-sales/.openclaw/workspace/SOUL.md`
- `/home/dev-user/cbfleet-rag-support/.openclaw/workspace/SOUL.md`
- `/home/dev-user/cbfleet-rag-manager/.openclaw/workspace/SOUL.md`
- `/home/dev-user/cbfleet-rag-dev/.openclaw/workspace/SOUL.md`
- `/home/dev-user/cbfleet-rag-it/.openclaw/workspace/SOUL.md`

---

## Files Modified

| File | Change |
|---|---|
| `proxy/server.js` | Added `skills/match` handler (RAG + pgvector cosine search) |
| `scripts/embed-skills.js` | New script — embeds all skills via Gemini API |
| `docs/SKILL_CHANGES.md` | This document |
| `docs/oc-fleet-project-doc.md` | Full project documentation |

---

## Testing

```bash
# Test skills/match endpoint
curl -s -X POST http://127.0.0.1:20000/fleet-api/skills/match \
  -H "Content-Type: application/json" \
  -d '{"fn":"skills/match","query":"qualify a lead","agent":"sales"}'

# Expected: lead-qualification returned with confidence ~0.73
```

---

## Rollback

To revert to full skill loading:
1. Restore old global protocol from `fleet.agent_configs` (version history preserved)
2. Restore SOUL.md files from git (`master` branch has old version)
3. Agents will preload skills on next restart

---

## Impact

| Metric | Before | After |
|---|---|---|
| Skills in context at startup | ~50 skills (~10k tokens) | 0 |
| Skills loaded per message | 0 (already in context) | 1 (only matched skill) |
| User confirmation before execution | None | Required (except silent skills) |
| Context window usage | High (fixed overhead) | Lean (intent-driven) |
| Skill management | Deploy + restart | Update DB via Nexus, instant |
