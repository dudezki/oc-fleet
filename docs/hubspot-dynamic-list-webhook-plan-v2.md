# HubSpot Dynamic List — Webhook Receiver Plan v2
**Adjusted for Callbox on-prem setup**
**Date:** April 14, 2026
**Author:** Fleet-Dev (adjusted from Joezer's original plan)
**Status:** 📋 PLAN — Not building yet

---

## What This Does

Replaces the HubSpot Custom Code workflow action with an external webhook.
HubSpot fires a POST to our hubspot-proxy when a contact matches `dynamic_list_allowed = Yes`.
The webhook evaluates the contact against active Deal ICP criteria and creates Target records for each qualifying deal.

---

## Stack (Our Setup — NOT Vercel/Next.js)

| Layer | Choice | Why |
|---|---|---|
| Receiver | **hubspot-proxy** (`server.js` on `:19003`) | Already exists, already has all HubSpot logic |
| HTTP client | `axios` | Already used throughout hubspot-proxy |
| Auth | `hubspot-oauth` proxy (`:19002`) | Already handles PAT rotation |
| Hosting | On-prem (192.168.50.34 or LXC) | No Vercel needed |
| Portal | **OneCRM** (`21203560`) | Dynamic List uses OneCRM, not MarketingCRM |
| Target object | `2-20106951` | Already hardcoded in existing proxy |
| ICP parsing | Inline in existing `runDynamicTierQuery()` | Already built |
| Env vars | `/oc-fleet/.env` | Already in place |
| Audit logging | `auditLog()` | Already built |

---

## Match Rule — Confirmed

**Rule B:** One contact can have **multiple Targets** — one per qualifying deal.
- Idempotency key: `contactId + dealId`
- Evaluate ALL associated deals for a contact
- Create a Target for each deal that passes ICP
- Duplicate check per `contactId + dealId` before every create

---

## Architecture

### Old (HubSpot Custom Code)
```
[HubSpot Workflow — Daily 5AM GMT]
  └── Enrolled contacts where dynamic_list_allowed = Yes
  └── [Custom Code action] ← runs inline in HubSpot
```

### New (Webhook)
```
[HubSpot Workflow — Daily 5AM GMT]
  └── Enrolled contacts where dynamic_list_allowed = Yes
  └── [Webhook action → POST /webhook/dynamic-list on hubspot-proxy]
          ↓
  [hubspot-proxy validates secret + payload]
          ↓
  [Fetch contact's associated deals (OneCRM)]
          ↓
  [Batch read deal properties (ICP DSL)]
          ↓
  [Parse + evaluate ICP per deal]
          ↓
  [Duplicate check per contactId+dealId]
          ↓
  [Create Target record per qualifying deal]
          ↓
  [Audit log]
```

---

## New Route to Add

**File:** `/home/dev-user/Projects/oc-fleet/hubspot-proxy/server.js`
**Route:** `POST /webhook/dynamic-list`

```js
app.post('/webhook/dynamic-list', async (req, res) => {
  // 1. Validate webhook secret (X-Webhook-Secret header)
  // 2. Validate payload shape (hs_object_id required)
  // 3. Normalize dynamic_list_allowed (Yes/true/1/True → true)
  // 4. If not allowed → skip, return 200
  // 5. Get HubSpot token from oauth proxy
  // 6. Fetch contact's associated deal IDs (via /crm/v4/objects/contacts/{id}/associations/deals)
  // 7. Batch read deal properties in chunks of 100
  //    → properties: dynamic_list_icp, dealname, pipeline, dealstage, hs_object_id
  // 8. For each deal:
  //    a. Parse dynamic_list_icp DSL (reuse existing icpFilters logic)
  //    b. Evaluate contact against ICP
  //    c. Check duplicate: search existing Targets for contactId+dealId
  //    d. Check cap (2,000 per dynamic_list_target value)
  //    e. If passes → createTarget(contactData, dealId)
  //    f. auditLog(...)
  // 9. Return { ok: true, processed: N, created: M }
})
```

---

## Environment Variables to Add

| Variable | Value | Notes |
|---|---|---|
| `HUBSPOT_WEBHOOK_SECRET` | `<shared secret>` | Must match HubSpot workflow custom header value |
| `DRY_RUN` | `false` | Set `true` to log without creating targets |

Add to `/home/dev-user/Projects/oc-fleet/.env`

---

## HubSpot Workflow Changes

Replace **Custom Code** action with **Webhook** action:

```
Method: POST
URL: https://oc.callboxinc.ai/hubspot-proxy/webhook/dynamic-list
  (or internal: http://127.0.0.1:19003/webhook/dynamic-list for direct)
Headers:
  X-Webhook-Secret: <same value as HUBSPOT_WEBHOOK_SECRET>
Body: Contact properties (see below)
```

### Webhook Payload Fields (HubSpot sends these)
```json
{
  "hs_object_id": "...",
  "email": "...",
  "phone": "...",
  "mobile": "...",
  "direct_number": "...",
  "first_name": "...",
  "last_name": "...",
  "company": "...",
  "country": "...",
  "city": "...",
  "state": "...",
  "postal_code": "...",
  "address": "...",
  "job_title": "...",
  "industry": "...",
  "website": "...",
  "linkedin": "...",
  "annual_revenue": "...",
  "employee_size": "...",
  "level": "...",
  "function": "...",
  "lead_source": "...",
  "dynamic_list_target": "...",
  "dynamic_list_allowed": "Yes"
}
```

### dynamic_list_allowed normalization
Treat as allowed: `true`, `"true"`, `"yes"`, `"Yes"`, `1`
Treat as blocked: anything else or missing

---

## ICP DSL Format (existing, unchanged)

```
country:PH|SG;job_title:CEO|CTO;employee_size:500GT
```

Parsed into:
```json
{
  "country": ["PH", "SG"],
  "job_title": ["CEO", "CTO"],
  "employee_size": ["500GT"]
}
```

Numeric operators: `GT` (≥), `LT` (≤), `BT` (between, e.g. `500BT1000`)

---

## HubSpot API Calls (OneCRM portal — 21203560)

| Call | Method | Endpoint |
|---|---|---|
| Get contact's deal IDs | GET | `/crm/v4/objects/contacts/{id}/associations/deals` |
| Batch read deals | POST | `/crm/v3/objects/deals/batch/read` (chunks of 100) |
| Search existing targets | POST | `/crm/v3/objects/2-20106951/search` |
| Create target | POST | `/crm/v3/objects/2-20106951` |

All calls routed via existing `hubspot-oauth` PAT (`:19002`).

---

## Safety Rules

| Concern | Implementation |
|---|---|
| Idempotency | Duplicate check per `contactId + dealId` before every create |
| Cap | 2,000 targets per `dynamic_list_target` value — abort before create if over cap |
| Secret validation | Reject immediately if `X-Webhook-Secret` missing or wrong |
| DRY_RUN | Log matches without creating targets when `DRY_RUN=true` |
| HubSpot retries | Handler is idempotent — safe to re-run same contact |
| Chunking | Batch read deals in slices of 100 |
| Pagination | Handle `paging.next.after` on association + search responses |
| PAT rotation | Via existing `hubspot-oauth` proxy (`:19002`) |
| Audit | `auditLog()` per contact processed |

---

## Testing Plan

| Test | Method |
|---|---|
| Secret validation | Send request with wrong/missing secret → expect 401 |
| Payload normalization | Various `dynamic_list_allowed` values → correct bool |
| ICP parse + match | Mock contact vs mock deal ICP string |
| Duplicate check | Same contactId+dealId twice → only 1 target created |
| Cap enforcement | >2,000 existing targets → no new target created |
| Dry run | `DRY_RUN=true` → log only, no HubSpot writes |
| Integration | Real contact + deal + target creation on sandbox |
| Production | Dry run first, then live |

---

## What We Reuse (No Rebuild Needed)

- ✅ `runDynamicTierQuery()` ICP filter logic
- ✅ `deduplicateRecords()` logic
- ✅ `auditLog()` function
- ✅ HubSpot OAuth PAT rotation (`:19002`)
- ✅ `DYNAMIC_LIST_PORTAL`, stage IDs, access control
- ✅ Existing `.env` setup

---

## Work Breakdown

| Task | Owner | Notes |
|---|---|---|
| Add `HUBSPOT_WEBHOOK_SECRET` + `DRY_RUN` to `.env` | Fleet-Dev | Simple |
| Add `POST /webhook/dynamic-list` route to `hubspot-proxy` | Fleet-Dev | ~80 lines |
| Update HubSpot Workflow: replace Custom Code with Webhook | Brian/Joezer | HubSpot UI |
| Test secret validation + dry run | Fleet-Dev | Before live |
| Integration test (sandbox) | Joint | |
| Go live + monitor | Joint | |

---

## Estimated Timeline

| Day | Task |
|---|---|
| Day 1 | Route built, env vars added, dry run working |
| Day 2 | Integration tested on sandbox |
| Day 3 | HubSpot workflow updated + production dry run |
| Day 4 | Go live |

**4 days, not 4 weeks** — existing infrastructure does the heavy lifting.

---

## Open Questions (Decide Before Build)

1. **Public URL for webhook:** `https://oc.callboxinc.ai/hubspot-proxy/webhook/dynamic-list` or internal IP? (If HubSpot can't reach internal, needs public URL or Tailscale Funnel)
2. **Webhook secret value:** Who generates it and adds it to HubSpot workflow?
3. **Cap definition:** 2,000 per `dynamic_list_target` value confirmed?
4. **DRY_RUN default:** Start `true` for first week?

---

*File: `/home/dev-user/Projects/oc-fleet/docs/hubspot-dynamic-list-webhook-plan-v2.md`*
*Last updated: April 14, 2026*
