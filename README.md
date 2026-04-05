# cbfleet-rag

Callbox Fleet RAG — 4 OpenClaw instances sharing centralized memory via Supabase + pgvector.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Supabase (fleet schema, ap-southeast-1)            │
│  memories | handoffs | conversations | agents       │
│  pgvector 1536-dim embeddings                       │
└─────────────────────────────────────────────────────┘
              ↕ API Proxy (:20000)
  ┌─────────┬────────────┬────────────┬───────────┐
  │  RAG    │   Sales    │  Support   │  Manager  │
  │ :19500  │  :19501   │  :19502   │  :19503   │
  └─────────┴────────────┴────────────┴───────────┘
```

## Instances

| Instance | Port  | Telegram Bot        | UUID |
|----------|-------|---------------------|------|
| RAG      | 19500 | @CBFleetRAG_bot     | `83e429b5-...` |
| Sales    | 19501 | @CBFleetSales_bot   | `b81c0d8a-...` |
| Support  | 19502 | @CBFleetSupport_bot | `325e5143-...` |
| Manager  | 19503 | @CBFleetManager_bot | `82061d1c-...` |

## Structure

```
cbfleet-rag/
├── instances/
│   ├── rag/
│   │   └── .openclaw/
│   │       ├── openclaw.json
│   │       ├── exec-approvals.json
│   │       └── workspace/
│   │           ├── SOUL.md
│   │           └── skills/fleet-rag/SKILL.md
│   ├── sales/
│   ├── support/
│   └── manager/
├── proxy/
│   ├── server.js          ← Fleet API proxy (port 20000)
│   └── package.json
├── schema/
│   └── fleet-rag-schema-migration.sql
├── scripts/
│   └── deploy-vps.sh      ← Full VPS deploy script
└── README.md
```

## VPS Deployment

```bash
# Clone repo on VPS, then:
ANTHROPIC_API_KEY=sk-ant-... bash scripts/deploy-vps.sh
```

The script handles:
1. Directory creation
2. Config + SOUL file deployment
3. API key injection
4. Proxy install + PM2 start
5. Gateway start (PM2)
6. Health check verification

## Supabase

- **Project:** `ynlpbhtztwzdktfyguwq` (ap-southeast-1)
- **Schema:** `fleet`
- **Org UUID:** `f86d92cb-db10-43ff-9ff2-d69c319d272d`
- **Dashboard:** https://joes-mac-studio.taila31434.ts.net/google-auth/fleet-rag/

## Known Issues

- Edge Functions need `DATABASE_URL` secret set in Supabase
- On Mac: exec/curl blocked inside non-default `OPENCLAW_HOME` — works fine on Linux VPS
