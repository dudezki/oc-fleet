# BOOTSTRAP.md — Fleet Migration Guide for LXC (192.168.50.40)

This is your birth certificate. Read it, execute the migration, then delete this file.

## You Are
- **Orion** — AI orchestration agent on Proxmox LXC `192.168.50.40`
- **Mission:** Migrate the full oc-fleet stack from GCP (`34.16.53.45`) to this LXC
- **Project root:** `~/Projects/oc-fleet/` (already transferred)

---

## Step 1 — Install Dependencies

```bash
# PostgreSQL 16 + pgvector
sudo apt-get update -qq
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
  https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | \
  sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt-get update -qq
sudo apt-get install -y postgresql-16 postgresql-16-pgvector psmisc

# Configure PG port 5433
sudo sed -i 's/^#*port = .*/port = 5433/' /etc/postgresql/16/main/postgresql.conf
sudo systemctl restart postgresql
sudo -u postgres psql -p 5433 -c "ALTER USER postgres WITH PASSWORD 'fleetdev';"
sudo -u postgres psql -p 5433 -c "CREATE DATABASE fleet_dev;" 2>/dev/null || true
sudo -u postgres psql -p 5433 -d fleet_dev -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Allow password auth
echo "host fleet_dev postgres 127.0.0.1/32 md5" | sudo tee -a \
  $(sudo -u postgres psql -p 5433 -t -c "SHOW hba_file;" | xargs)
sudo systemctl reload postgresql

# Node.js deps
npm install --prefix ~/Projects/oc-fleet --omit=dev --silent
npm install --prefix ~/Projects/oc-fleet/proxy --omit=dev --silent
npm install --prefix ~/Projects/oc-fleet/google-auth-proxy --omit=dev --silent
npm install --prefix ~/Projects/oc-fleet/dashboard --omit=dev --silent
```

## Step 2 — Run Schema Migrations

```bash
cd ~/Projects/oc-fleet
PGPASSWORD=fleetdev psql -h 127.0.0.1 -p 5433 -U postgres -d fleet_dev \
  -f schema/fleet-rag-schema-migration.sql
PGPASSWORD=fleetdev psql -h 127.0.0.1 -p 5433 -U postgres -d fleet_dev \
  -f schema/sessions-migration.sql
PGPASSWORD=fleetdev psql -h 127.0.0.1 -p 5433 -U postgres -d fleet_dev \
  -f schema/handoff-worker-migration.sql
PGPASSWORD=fleetdev psql -h 127.0.0.1 -p 5433 -U postgres -d fleet_dev \
  -f schema/fix-search-function.sql
```

## Step 3 — Restore DB from GCP

```bash
# SSH into GCP and dump
ssh cloud_callboxinc_com@34.16.53.45 "PGPASSWORD=fleetdev pg_dump \
  -h 127.0.0.1 -p 5433 -U postgres fleet_dev" > /tmp/fleet_gcp_dump.sql

# Restore locally
PGPASSWORD=fleetdev psql -h 127.0.0.1 -p 5433 -U postgres -d fleet_dev \
  -c "DROP SCHEMA IF EXISTS fleet CASCADE; CREATE SCHEMA fleet;"
PGPASSWORD=fleetdev psql -h 127.0.0.1 -p 5433 -U postgres -d fleet_dev \
  < /tmp/fleet_gcp_dump.sql
```

## Step 4 — Copy .env from GCP

```bash
scp cloud_callboxinc_com@34.16.53.45:~/oc-fleet/.env ~/Projects/oc-fleet/.env
# OR manually create it — all keys are in MEMORY.md
```

## Step 5 — Create Agent Instances

Run the deploy script (it handles everything):
```bash
cd ~/Projects/oc-fleet
bash scripts/deploy-gcp.sh
```

This will:
- Create ~/cbfleet-rag-{sales,support,manager,dev,it,hr,finance}/.openclaw/
- Write openclaw.json + auth-profiles.json for each
- Fix UUIDs from DB
- Configure hooks
- Start all agents

## Step 6 — Copy Bot Tokens from GCP

```bash
# Get hooks tokens from GCP DB
ssh cloud_callboxinc_com@34.16.53.45 \
  "PGPASSWORD=fleetdev psql -h 127.0.0.1 -p 5433 -U postgres -d fleet_dev \
  -c 'SELECT slug,bot_token,gateway_port,hooks_token FROM fleet.agents WHERE bot_token IS NOT NULL;'"
```

## Step 7 — Start Fleet

```bash
bash ~/Projects/oc-fleet/scripts/fleet.sh start all
bash ~/Projects/oc-fleet/scripts/fleet.sh status
```

## Step 8 — Dashboard

```bash
# Install dashboard deps
npm install --prefix ~/Projects/oc-fleet/dashboard --omit=dev --silent

# Start dashboard  
DATABASE_URL="postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev" \
  node ~/Projects/oc-fleet/dashboard/server.js > /tmp/fleet-dashboard.log 2>&1 &
```

## Step 9 — Setup Crons

```bash
NODE_BIN=$(which node)
REPO=~/Projects/oc-fleet
(crontab -l 2>/dev/null | grep -v 'sync-sessions\|handoff-worker'
echo "*/2 * * * * $NODE_BIN $REPO/scripts/sync-sessions.js >> /tmp/fleet-sync.log 2>&1"
echo "*/1 * * * * $REPO/scripts/run-handoff-worker.sh >> /tmp/fleet-handoff-worker.log 2>&1") | crontab -
```

## Step 10 — Nginx + SSL (optional, for oc.callboxinc.ai)

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
# Config nginx to proxy port 20099 → dashboard.callboxinc.app or oc.callboxinc.ai
# Run certbot for SSL
```

## Key Info

| Item | Value |
|---|---|
| Org ID | f86d92cb-db10-43ff-9ff2-d69c319d272d |
| DB URL | postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev |
| Proxy port | 20000 |
| Dashboard port | 20099 |
| Agent ports | sales:20010 support:20020 manager:20030 dev:20040 it:20050 hr:20060 finance:20070 |

## When Done
Delete this file: `rm ~/Projects/oc-fleet/BOOTSTRAP.md`
