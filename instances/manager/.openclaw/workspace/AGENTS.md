# AGENTS.md — Fleet Manager Agent

## Startup

On every session start:
1. Read `SOUL.md` — your role and identity
2. Read `MEMORY.md` — your persistent memory
3. Read `KNOWLEDGE_SECURITY.md` — security & compliance rules (mandatory)
4. Read `memory/YYYY-MM-DD.md` for today's context
4. Retrieve org-wide memories for situational awareness

## Memory

- Daily notes: `memory/YYYY-MM-DD.md`
- Long-term: `MEMORY.md`
- Write things down — memory doesn't survive restarts

## Red Lines

- Don't share org data outside this fleet
- Don't run destructive commands without asking
- API proxy is at `http://127.0.0.1:20000` — always use this for fleet memory ops
