# Sales Meeting Intel — v2 Redesign Plan
**Prepared by:** Fleet-Dev
**Date:** April 14, 2026
**Status:** 📋 PLAN — Ready for implementation
**Replaces:** Polling-based cron (`bf580209-6952-4942-b1aa-f7a9dc165eb3`)

---

## 🎯 Objective

Replace the 10-minute polling cron with an event-driven webhook architecture using HubSpot Workflows + direct Anthropic API calls. Eliminates wasted API calls, reduces latency from 10 minutes to under 5 seconds, and removes dependency on OpenClaw agent turns.

---

## ❌ Old Architecture (Removed)

```
[OpenClaw cron — every 10 min]
        ↓
[Poll HubSpot /crm/v3/ search API]
        ↓
[OpenClaw agent turn — Sales Bot]
        ↓
[Claude via agent session]
        ↓
[Google Doc] + [Telegram DM]
```

**Problems:**
- 144+ HubSpot API calls/day (even when no new contacts)
- Up to 10-minute delay before intel doc is generated
- Legacy `/crm/v3/` endpoints (deprecated)
- Token waste on empty poll runs (~200 tokens × 144 calls = ~28,800 tokens/day wasted)
- Tied to agent session lifecycle — harder to debug

---

## ✅ New Architecture (v2)

```
[HubSpot Contact/Call Updated]
        ↓
[HubSpot Workflow fires outbound webhook]
        ↓
[Fleet Proxy — POST /fleet-api/hooks/sales-meeting-intel]
        ↓
[Validates payload + dedup check]
        ↓
[Direct Anthropic API call — claude-sonnet-4-6]
  → Fetches enriched contact/call data from HubSpot 2026-03 API
  → Runs PRE-MEETING / ICP+TAM / POST-MEETING prompts
        ↓
[Google Docs API — creates doc in owner's Drive]
        ↓
[Telegram DM — notifies deal owner]
        ↓
[HubSpot — marks contact as processed]
```

---

## 📋 Flows

### Flow A — PRE-MEETING + ICP+TAM

**HubSpot Workflow Trigger:**
- `hs_lead_status` changes to `Appointment Set by SDR`
- AND `callbox_first_appointment_date` is known

**Webhook Payload:**
```json
{
  "flow": "pre-meeting",
  "contact_id": "{{contact.id}}",
  "owner_id": "{{contact.hubspot_owner_id}}",
  "appointment_date": "{{contact.callbox_first_appointment_date}}",
  "portal_id": "4950628"
}
```

**Processing:**
1. Validate `portal_id = 4950628`
2. Check `callbox_premeet_generated != true` (dedup)
3. Fetch contact fields via HubSpot 2026-03 API: `company`, `firstname`, `lastname`, `jobtitle`, `website`, `hs_lead_source`
4. Lookup owner email → Telegram ID via fleet proxy
5. Run PRE-MEETING prompt → Claude
6. Run ICP+TAM prompt → Claude
7. Create Google Doc: `PRE-MEETING — {Name} {Company} {YYYY-MM-DD}`
8. Send Telegram DM to owner
9. Set `callbox_premeet_generated = true` on HubSpot contact

---

### Flow B — POST-MEETING

**HubSpot Workflow Trigger:**
- Call object created where title starts with `Exploratory Meeting`
- AND `hs_call_body` is known (notes exist)

**Webhook Payload:**
```json
{
  "flow": "post-meeting",
  "call_id": "{{call.id}}",
  "contact_id": "{{call.contact_id}}",
  "owner_id": "{{call.hubspot_owner_id}}",
  "call_notes": "{{call.hs_call_body}}",
  "portal_id": "4950628"
}
```

**Processing:**
1. Validate `portal_id = 4950628`
2. Check `callbox_postmeet_generated != true` (dedup)
3. Fetch contact fields via HubSpot 2026-03 API
4. Run POST-MEETING prompt with `call_notes` → Claude
5. Create Google Doc: `POST-MEETING — {Name} {Company} {YYYY-MM-DD}`
6. Send Telegram DM to owner
7. Set `callbox_postmeet_generated = true` on HubSpot contact

---

## 🔧 Implementation Components

### 1. Fleet Proxy — New Webhook Handler
**File:** `/home/dev-user/Projects/oc-fleet/proxy/server.js`
**New route:** `POST /fleet-api/hooks/sales-meeting-intel`
- Validates HubSpot signature (optional, for security)
- Validates `portal_id`
- Passes to worker function

### 2. Webhook Worker Service
**File:** `/home/dev-user/Projects/oc-fleet/scripts/sales-meeting-intel-webhook.js`
- Standalone Node.js module (no OpenClaw agent dependency)
- Direct Anthropic SDK calls
- Google Docs API via `google-auth-proxy` (`:19001`)
- HubSpot API via `hubspot-proxy` (`:19003`)
- Telegram via fleet proxy

### 3. HubSpot API Migration
- All calls migrated from `/crm/v3/` → `/crm/objects/2026-03/`
- Contact fetch: `GET https://api.hubapi.com/crm/objects/2026-03/contacts/{id}`
- Property update: `PATCH https://api.hubapi.com/crm/objects/2026-03/contacts/{id}`

### 4. Disable Old Cron
- Cron ID: `bf580209-6952-4942-b1aa-f7a9dc165eb3`
- Delete after webhook is confirmed working

---

## 💰 Token Cost Analysis

### Old Architecture (Polling-based)

| Item | Volume | Tokens/run | Daily Tokens |
|------|--------|-----------|-------------|
| Empty poll runs (no contacts) | ~138/day | ~800 (system prompt + check) | ~110,400 |
| Active poll runs (contact found) | ~6/day | ~3,500 (prompt + generation) | ~21,000 |
| **Total daily tokens** | | | **~131,400** |
| **Monthly tokens** | | | **~3,942,000** |
| **Monthly cost (Sonnet 4.6)** | | | **~$19.71** |

> Breakdown: 131,400 tokens/day × 30 = 3,942,000/mo
> Input ~80% cached at $0.30/M = $0.95; fresh at $3.00/M = $9.47; Output at $15.00/M = $9.44
> **Total ≈ $19.86/month**

---

### New Architecture (Webhook-based)

| Item | Volume | Tokens/run | Daily Tokens |
|------|--------|-----------|-------------|
| Idle (no HubSpot events) | 0 | 0 | **0** |
| PRE-MEETING run | ~4/day avg | ~2,800 | ~11,200 |
| POST-MEETING run | ~2/day avg | ~2,500 | ~5,000 |
| **Total daily tokens** | | | **~16,200** |
| **Monthly tokens** | | | **~486,000** |
| **Monthly cost (Sonnet 4.6)** | | | **~$2.43** |

> Input at $3.00/M = $1.46; Output at $15.00/M = $1.09 (no caching needed — no repeated system prompts)
> **Total ≈ $2.43/month**

---

### Savings Summary

| Metric | Old | New | Savings |
|--------|-----|-----|---------|
| Daily tokens | ~131,400 | ~16,200 | **88% less** |
| Monthly tokens | ~3,942,000 | ~486,000 | **-3,456,000** |
| Monthly cost | ~$19.86 | ~$2.43 | **$17.43/mo saved** |
| Trigger latency | up to 10 min | < 5 sec | **99% faster** |
| Wasted API calls | 138/day | 0 | **100% eliminated** |
| HubSpot API version | v3 (legacy) | 2026-03 (current) | ✅ |

---

## 📋 Work Breakdown

| Task | Owner | Status |
|------|-------|--------|
| Webhook handler in fleet proxy | Fleet-Dev | 🔲 Todo |
| Webhook worker service (Node.js) | Fleet-Dev | 🔲 Todo |
| HubSpot API migration (v3 → 2026-03) | Fleet-Dev | 🔲 Todo |
| HubSpot Workflow A (PRE-MEETING) | Brian Butler | 🔲 Pending |
| HubSpot Workflow B (POST-MEETING) | Brian Butler | 🔲 Pending |
| Test end-to-end (test webhook → doc) | Joint | 🔲 Pending |
| Disable old cron | Fleet-Dev | 🔲 After test |

---

## 🔑 Key Rules (Unchanged)
- Never re-process a contact/call already marked as processed
- No em dashes in any generated output (Jaime's writing preference)
- Contact owner scope only — notify deal owner only, never whole team
- Never send external emails without explicit approval
- Fallback Telegram: Sheryll Colindres (`8618648518`) if owner has no Telegram ID

---

## 📁 File Locations
- This plan: `/home/dev-user/Projects/oc-fleet/docs/sales-meeting-intel-v2-plan.md`
- Old poller: `/home/dev-user/Projects/oc-fleet/scripts/sales-meeting-intel-poll.js` (to be deleted)
- New worker: `/home/dev-user/Projects/oc-fleet/scripts/sales-meeting-intel-webhook.js` (to be created)
- Old skill: `/home/dev-user/backup/fleet-v1-scripts/cron-full-export/cron-full-export/skills/sales/sales-meeting-intel/`
- Prompts: same location `/references/prompts.md` (unchanged)
