#!/usr/bin/env bash
# =============================================================================
# oc-fleet — GCP Compute Engine Deploy Script
# Tested on: Ubuntu 22.04 LTS (e2-medium or higher recommended)
#
# Usage:
#   1. SSH into your GCP VM
#   2. git clone https://github.com/dudezki/oc-fleet.git
#   3. cd oc-fleet && cp .env.example .env && nano .env
#   4. bash scripts/deploy-gcp.sh
#
# What it does:
#   - Installs Node.js 24, PostgreSQL 16 + pgvector, OpenClaw
#   - Creates fleet_dev database, runs schema migration
#   - Installs proxy, dashboard, google-auth-proxy deps
#   - Creates OpenClaw instance dirs for all 5 agents
#   - Writes fleet.sh management script
#   - Sets up sync-sessions cron
#   - Starts everything
# =============================================================================

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_LOG="/tmp/fleet-deploy.log"
exec > >(tee -a "$DEPLOY_LOG") 2>&1

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Load .env ────────────────────────────────────────────────────────────────
ENV_FILE="$REPO_DIR/.env"
[ -f "$ENV_FILE" ] || die ".env not found — copy .env.example and fill in secrets"
set -a; source "$ENV_FILE"; set +a
success "Loaded .env"

# ── Required vars check ──────────────────────────────────────────────────────
for var in ANTHROPIC_API_KEY GEMINI_API_KEY GATEWAY_TOKEN_SALES GATEWAY_TOKEN_SUPPORT GATEWAY_TOKEN_MANAGER; do
  [ -n "${!var:-}" ] || die "Missing required env var: $var"
done

GATEWAY_TOKEN_DEV="${GATEWAY_TOKEN_DEV:-$(openssl rand -hex 32)}"
GATEWAY_TOKEN_IT="${GATEWAY_TOKEN_IT:-$(openssl rand -hex 32)}"
GATEWAY_TOKEN_RAG="${GATEWAY_TOKEN_RAG:-$(openssl rand -hex 32)}"

BOT_TOKEN_SALES="${BOT_TOKEN_SALES:-8635294015:AAFJ-Xv6hPuON6I9y0XmTCS824HtnIZGHkU}"
BOT_TOKEN_SUPPORT="${BOT_TOKEN_SUPPORT:-8704189878:AAENJYhtN7824JJ29W5MHwitmz7xmXIslGM}"
BOT_TOKEN_MANAGER="${BOT_TOKEN_MANAGER:-8466627149:AAG-tSQhzFMIiggvlj8r4VwtE9TyXUL7Dlg}"
BOT_TOKEN_DEV="${BOT_TOKEN_DEV:-8711513128:AAG1rumx-ragdgt5MnibQHpGJ-YJZv_fltc}"
BOT_TOKEN_IT="${BOT_TOKEN_IT:-8573728913:AAGfKvlnO2yb2Oa2oVLXJTtShJQtEkDuHX0}"

ORG_ID="${ORG_ID:-f86d92cb-db10-43ff-9ff2-d69c319d272d}"
PG_PORT="${PG_PORT:-5433}"
PG_PASS="${PG_PASSWORD:-fleetdev}"
PG_DB="${PG_DATABASE:-fleet_dev}"
PG_USER_VAR="${PG_USER:-postgres}"
DB_URL_LOCAL="postgresql://$PG_USER_VAR:$PG_PASS@127.0.0.1:$PG_PORT/$PG_DB"

# ── System packages ──────────────────────────────────────────────────────────
info "Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq curl wget git unzip openssl ca-certificates gnupg lsb-release \
  build-essential psmisc
success "System packages ready"

# ── Node.js 24 ───────────────────────────────────────────────────────────────
if ! node --version 2>/dev/null | grep -q "v24"; then
  info "Installing Node.js 24..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - > /dev/null
  sudo apt-get install -y nodejs
  success "Node.js $(node --version) installed"
else
  success "Node.js $(node --version) already installed"
fi

# ── OpenClaw ─────────────────────────────────────────────────────────────────
if ! command -v openclaw &>/dev/null; then
  info "Installing OpenClaw..."
  sudo npm install -g openclaw --silent
  success "OpenClaw installed"
else
  success "OpenClaw already installed"
fi

# ── PostgreSQL 16 + pgvector ─────────────────────────────────────────────────
if ! command -v psql &>/dev/null || ! psql --version 2>/dev/null | grep -q "16"; then
  info "Installing PostgreSQL 16 + pgvector..."
  sudo apt-get install -y curl ca-certificates
  sudo install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
    https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | \
    sudo tee /etc/apt/sources.list.d/pgdg.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y postgresql-16 postgresql-16-pgvector
  success "PostgreSQL 16 + pgvector installed"
else
  success "PostgreSQL already installed: $(psql --version)"
fi

# Configure port
PG_CONF=$(sudo -u postgres psql -t -c "SHOW config_file;" 2>/dev/null | xargs || true)
if [ -n "$PG_CONF" ]; then
  CURRENT_PORT=$(sudo -u postgres psql -t -c "SHOW port;" 2>/dev/null | xargs || echo "5432")
  if [ "$CURRENT_PORT" != "$PG_PORT" ]; then
    info "Setting PostgreSQL port to $PG_PORT..."
    sudo sed -i "s/^#*port = .*/port = $PG_PORT/" "$PG_CONF"
    sudo systemctl restart postgresql
    sleep 3
  fi
fi

sudo systemctl enable postgresql --now 2>/dev/null || true
for i in $(seq 1 20); do
  sudo -u postgres pg_isready -p "$PG_PORT" -q 2>/dev/null && break
  sleep 1
done
sudo -u postgres pg_isready -p "$PG_PORT" -q || die "PostgreSQL failed to start"
success "PostgreSQL running on port $PG_PORT"

# Create DB + user
info "Setting up database: $PG_DB..."
sudo -u postgres psql -p "$PG_PORT" <<SQL 2>/dev/null || true
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$PG_USER_VAR') THEN
    CREATE USER $PG_USER_VAR WITH SUPERUSER PASSWORD '$PG_PASS';
  ELSE
    ALTER USER $PG_USER_VAR WITH PASSWORD '$PG_PASS';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE $PG_DB' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$PG_DB')\gexec
SQL

sudo -u postgres psql -p "$PG_PORT" -d "$PG_DB" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || true
success "Database $PG_DB ready"

# Allow password auth on localhost
PG_HBA=$(sudo -u postgres psql -p "$PG_PORT" -t -c "SHOW hba_file;" 2>/dev/null | xargs || true)
if [ -n "$PG_HBA" ]; then
  if ! grep -q "host.*$PG_DB.*$PG_USER_VAR.*127.0.0.1" "$PG_HBA" 2>/dev/null; then
    echo "host    $PG_DB    $PG_USER_VAR    127.0.0.1/32    md5" | sudo tee -a "$PG_HBA" > /dev/null
    sudo systemctl reload postgresql
  fi
fi

# ── Schema migrations ────────────────────────────────────────────────────────
run_migration() {
  local file="$1" label="$2"
  if [ -f "$file" ]; then
    info "Running migration: $label..."
    PGPASSWORD="$PG_PASS" psql -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER_VAR" -d "$PG_DB" -f "$file" \
      && success "$label complete" \
      || warn "$label had errors (may be safe if objects already exist)"
  else
    warn "Migration file not found: $file"
  fi
}

run_migration "$REPO_DIR/schema/fleet-rag-schema-migration.sql" "Base schema"
run_migration "$REPO_DIR/schema/sessions-migration.sql"         "Sessions schema"

# ── Node.js deps ─────────────────────────────────────────────────────────────
install_deps() {
  local dir="$1" label="$2"
  [ -f "$dir/package.json" ] || return
  info "Installing deps: $label"
  npm install --prefix "$dir" --omit=dev --silent
  success "$label deps installed"
}

install_deps "$REPO_DIR/proxy"             "fleet-proxy"
install_deps "$REPO_DIR/google-auth-proxy" "google-auth-proxy"

DASHBOARD_DIR="${DASHBOARD_DIR:-$(dirname "$REPO_DIR")/cbfleet-dashboard}"
DASHBOARD_JS=""
if [ -d "$DASHBOARD_DIR" ]; then
  install_deps "$DASHBOARD_DIR" "cbfleet-dashboard"
  DASHBOARD_JS="$DASHBOARD_DIR/server.js"
else
  warn "Dashboard dir not found at $DASHBOARD_DIR — set DASHBOARD_DIR in .env to override"
fi

# ── Create OpenClaw instance dirs ────────────────────────────────────────────
create_instance() {
  local name="$1" port="$2" gateway_token="$3" bot_token="$4" agent_name="$5" model="${6:-claude-sonnet-4-6}"
  local home="$HOME/cbfleet-rag-$name"
  local oc_dir="$home/.openclaw"
  info "Setting up instance: $agent_name ($home)"
  mkdir -p "$oc_dir/identity" "$oc_dir/workspace"

  cat > "$oc_dir/openclaw.json" <<EOF
{
  "gateway": { "port": $port, "mode": "local", "bind": "loopback",
    "auth": { "mode": "token", "token": "$gateway_token" } },
  "auth": { "profiles": { "anthropic:default": { "provider": "anthropic", "mode": "token" } } },
  "agents": {
    "list": [{ "id": "main", "name": "$agent_name", "model": "$model" }],
    "defaults": { "timeoutSeconds": 300 }
  },
  "tools": { "exec": { "host": "gateway", "security": "full", "ask": "off" } },
  "channels": {
    "telegram": {
      "enabled": true, "dmPolicy": "open", "allowFrom": ["*"],
      "groupPolicy": "open", "streaming": "partial", "defaultAccount": "default",
      "accounts": {
        "default": {
          "botToken": "$bot_token", "dmPolicy": "open", "allowFrom": ["*"],
          "groups": { "*": { "requireMention": false } },
          "streaming": "partial", "actions": { "reactions": true }
        }
      }
    }
  },
  "session": { "dmScope": "main" }
}
EOF

  # auth-profiles must exist in BOTH identity/ and agents/main/agent/ (OpenClaw requirement)
  for auth_dir in "$oc_dir/identity" "$oc_dir/agents/main/agent"; do
    mkdir -p "$auth_dir"
    cat > "$auth_dir/auth-profiles.json" <<EOF
{
  "version": 1,
  "profiles": {
    "anthropic:default": { "type": "token", "provider": "anthropic", "token": "$ANTHROPIC_API_KEY" }
  },
  "lastGood": { "anthropic": "anthropic:default" }
}
EOF
  done

  # Copy SOUL.md and fix UUID to match DB exactly
  local soul_src="$REPO_DIR/instances/$name/SOUL.md"
  if [ -f "$soul_src" ]; then
    cp "$soul_src" "$oc_dir/workspace/SOUL.md"
    # Get correct agent UUID from DB and fix any typos in SOUL.md
    local db_uuid
    db_uuid=$(PGPASSWORD="$PG_PASS" psql -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER_VAR" -d "$PG_DB" -t -c \
      "SELECT id FROM fleet.agents WHERE slug='$name' LIMIT 1;" 2>/dev/null | xargs)
    if [ -n "$db_uuid" ]; then
      # Replace any UUID in SOUL.md that differs with the correct one
      local soul_uuid
      soul_uuid=$(grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
        "$oc_dir/workspace/SOUL.md" | head -1)
      if [ -n "$soul_uuid" ] && [ "$soul_uuid" != "$db_uuid" ]; then
        sed -i "s/$soul_uuid/$db_uuid/g" "$oc_dir/workspace/SOUL.md"
        warn "  Fixed UUID in $name SOUL.md: $soul_uuid → $db_uuid"
      fi
    fi
  fi

  # Also add hooks config with distinct token
  local hooks_token
  hooks_token=$(openssl rand -hex 32)
  python3 -c "
import json
f='$oc_dir/openclaw.json'
with open(f) as fp: d=json.load(fp)
d['hooks'] = {'enabled': True, 'path': '/hooks', 'token': '$hooks_token', 'allowedAgentIds': ['main']}
with open(f,'w') as fp: json.dump(d, fp, indent=2)
" 2>/dev/null || true

  success "  $agent_name → port $port"
}

create_instance "sales"   20010 "$GATEWAY_TOKEN_SALES"   "$BOT_TOKEN_SALES"   "Fleet-Sales"   "claude-sonnet-4-6"
create_instance "support" 20020 "$GATEWAY_TOKEN_SUPPORT" "$BOT_TOKEN_SUPPORT" "Fleet-Support" "claude-sonnet-4-6"
create_instance "manager" 20030 "$GATEWAY_TOKEN_MANAGER" "$BOT_TOKEN_MANAGER" "Fleet-Manager" "claude-sonnet-4-6"
create_instance "dev"     20040 "$GATEWAY_TOKEN_DEV"     "$BOT_TOKEN_DEV"     "Fleet-Dev"     "claude-sonnet-4-6"
create_instance "it"      20050 "$GATEWAY_TOKEN_IT"      "$BOT_TOKEN_IT"      "Fleet-IT"      "claude-haiku-4-5"
create_instance "hr"      20060 "${GATEWAY_TOKEN_HR:-$(openssl rand -hex 32)}" "${BOT_TOKEN_HR:-}" "Fleet-HR"      "claude-sonnet-4-6"
create_instance "finance" 20070 "${GATEWAY_TOKEN_FINANCE:-$(openssl rand -hex 32)}" "${BOT_TOKEN_FINANCE:-}" "Fleet-Finance" "claude-sonnet-4-6"

# ── fleet.sh ─────────────────────────────────────────────────────────────────
info "Writing fleet.sh..."
FLEET_SCRIPT="$HOME/fleet.sh"

cat > "$FLEET_SCRIPT" <<FLEET_EOF
#!/usr/bin/env bash
cmd="\${1:-status}"; target="\${2:-all}"
port_for()  { case \$1 in sales) echo 20010;; support) echo 20020;; manager) echo 20030;; dev) echo 20040;; it) echo 20050;; esac; }
home_for()  { echo "\$HOME/cbfleet-rag-\$1"; }
instances() { [ "\$target" = "all" ] && echo "sales support manager dev it" || echo "\$target"; }

PROXY_PORT=20000; PROXY_JS=$REPO_DIR/proxy/server.js
DASHBOARD_PORT=20099; DASHBOARD_JS=${DASHBOARD_JS}
GOOGLE_AUTH_PORT=19001; GOOGLE_AUTH_JS=$REPO_DIR/google-auth-proxy/server.js

kill_port() { fuser -k \$1/tcp 2>/dev/null || true; }

start_proxy() {
  kill_port \$PROXY_PORT; sleep 0.5
  set -a; [ -f "$REPO_DIR/.env" ] && source "$REPO_DIR/.env"; set +a
  DATABASE_URL="$DB_URL_LOCAL" node "\$PROXY_JS" > /tmp/fleet-proxy.log 2>&1 &
  echo \$! > /tmp/fleet-proxy.pid; sleep 1
  r=\$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:\$PROXY_PORT/fleet-api/retrieve \
    -H "Content-Type: application/json" -d '{"org_id":"$ORG_ID"}' 2>/dev/null)
  [ "\$r" = "200" ] && echo "  ✅ proxy up (:\$PROXY_PORT)" || echo "  ❌ proxy failed — tail /tmp/fleet-proxy.log"
}

stop_proxy() {
  [ -f /tmp/fleet-proxy.pid ] && kill "\$(cat /tmp/fleet-proxy.pid)" 2>/dev/null; rm -f /tmp/fleet-proxy.pid
  kill_port \$PROXY_PORT; echo "⏹  Stopped proxy"
}

start_dashboard() {
  [ -z "\$DASHBOARD_JS" ] || [ ! -f "\$DASHBOARD_JS" ] && { echo "  ⚠️  Dashboard not configured"; return; }
  kill_port \$DASHBOARD_PORT; sleep 0.5
  DATABASE_URL="$DB_URL_LOCAL" node "\$DASHBOARD_JS" > /tmp/fleet-dashboard.log 2>&1 &
  echo \$! > /tmp/fleet-dashboard.pid; sleep 1
  r=\$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:\$DASHBOARD_PORT/api/status 2>/dev/null)
  [ "\$r" = "200" ] && echo "  ✅ dashboard up (:\$DASHBOARD_PORT)" || echo "  ❌ dashboard failed — tail /tmp/fleet-dashboard.log"
}

stop_dashboard() {
  [ -f /tmp/fleet-dashboard.pid ] && kill "\$(cat /tmp/fleet-dashboard.pid)" 2>/dev/null; rm -f /tmp/fleet-dashboard.pid
  kill_port \$DASHBOARD_PORT; echo "⏹  Stopped dashboard"
}

start_google_auth() {
  kill_port \$GOOGLE_AUTH_PORT; sleep 0.5
  GOOGLE_CLIENT_ID="\${GOOGLE_CLIENT_ID}" GOOGLE_CLIENT_SECRET="\${GOOGLE_CLIENT_SECRET}" \
  GOOGLE_REDIRECT_URI="\${GOOGLE_REDIRECT_URI}" TOKEN_STORE_DIR="\${HOME}/.callbox-google-tokens" \
  DATABASE_URL="$DB_URL_LOCAL" node "\$GOOGLE_AUTH_JS" > /tmp/fleet-google-auth.log 2>&1 &
  echo \$! > /tmp/fleet-google-auth.pid; sleep 2
  r=\$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:\$GOOGLE_AUTH_PORT/health 2>/dev/null)
  [ "\$r" = "200" ] && echo "  ✅ google-auth up (:\$GOOGLE_AUTH_PORT)" || echo "  ❌ google-auth failed"
}

stop_google_auth() {
  [ -f /tmp/fleet-google-auth.pid ] && kill "\$(cat /tmp/fleet-google-auth.pid)" 2>/dev/null; rm -f /tmp/fleet-google-auth.pid
  kill_port \$GOOGLE_AUTH_PORT; echo "⏹  Stopped google-auth"
}

start_instance() {
  local inst=\$1 port home
  port=\$(port_for "\$inst"); home=\$(home_for "\$inst")
  echo "▶ Starting \$inst on :\$port"
  OPENCLAW_HOME="\$home" openclaw gateway run --port "\$port" --force > /tmp/fleet-\$inst.log 2>&1 &
  echo \$! > /tmp/fleet-\$inst.pid; sleep 5
  r=\$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:\$port/health 2>/dev/null)
  [ "\$r" = "200" ] && echo "  ✅ \$inst up (:\$port)" || echo "  ❌ \$inst failed — tail /tmp/fleet-\$inst.log"
}

stop_instance() {
  local inst=\$1 port pid_file
  port=\$(port_for "\$inst"); pid_file=/tmp/fleet-\$inst.pid
  [ -f "\$pid_file" ] && kill "\$(cat \$pid_file)" 2>/dev/null; rm -f "\$pid_file"
  kill_port \$port && echo "⏹  Stopped \$inst (:\$port)" || echo "   \$inst not running"
}

status_all() {
  echo "=== Fleet Status ==="
  for inst in sales support manager dev it; do
    port=\$(port_for "\$inst")
    r=\$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:\$port/health 2>/dev/null)
    [ "\$r" = "200" ] && echo "  ✅ \$inst   :\$port" || echo "  ❌ \$inst   :\$port  (down)"
  done
  rp=\$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:20000/fleet-api/retrieve \
    -H "Content-Type: application/json" -d '{"org_id":"$ORG_ID"}' 2>/dev/null)
  [ "\$rp" = "200" ] && echo "  ✅ proxy     :20000" || echo "  ❌ proxy     :20000  (down)"
  rd=\$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:\$DASHBOARD_PORT/api/status 2>/dev/null)
  [ "\$rd" = "200" ] && echo "  ✅ dashboard :\$DASHBOARD_PORT" || echo "  ❌ dashboard :\$DASHBOARD_PORT  (down)"
}

case "\$cmd" in
  start)   [ "\$target" = "all" ] && { start_proxy; start_dashboard; start_google_auth; }
           for inst in \$(instances); do start_instance "\$inst"; done ;;
  stop)    for inst in \$(instances); do stop_instance "\$inst"; done
           [ "\$target" = "all" ] && { stop_proxy; stop_dashboard; stop_google_auth; } ;;
  restart) for inst in \$(instances); do stop_instance "\$inst"; done
           [ "\$target" = "all" ] && { stop_proxy; stop_dashboard; stop_google_auth; sleep 1
             start_proxy; start_dashboard; start_google_auth; }
           sleep 1; for inst in \$(instances); do start_instance "\$inst"; done ;;
  proxy)     stop_proxy;     start_proxy ;;
  dashboard) stop_dashboard; start_dashboard ;;
  google-auth) stop_google_auth; start_google_auth ;;
  status)    status_all ;;
  *) echo "Usage: fleet.sh [start|stop|restart|proxy|dashboard|status] [sales|support|manager|dev|it|all]" ;;
esac
FLEET_EOF

chmod +x "$FLEET_SCRIPT"
sudo ln -sf "$FLEET_SCRIPT" /usr/local/bin/fleet 2>/dev/null || true
success "fleet.sh written — also available as 'fleet' command"

# ── Cron jobs ─────────────────────────────────────────────────────────────────
info "Setting up cron jobs..."
NODE_BIN=$(which node 2>/dev/null || echo "/usr/local/bin/node")

# Write handoff-worker wrapper with correct PATH for cron context
cat > "$REPO_DIR/scripts/run-handoff-worker.sh" <<WRAPPER
#!/usr/bin/env bash
export PATH="$(dirname $NODE_BIN):/usr/local/bin:\$PATH"
export DATABASE_URL="$DB_URL_LOCAL"
export ORG_ID="$ORG_ID"
exec node "$REPO_DIR/scripts/handoff-worker.js"
WRAPPER
chmod +x "$REPO_DIR/scripts/run-handoff-worker.sh"

# Build crontab (remove stale entries, add fresh)
NEW_CRON=$(crontab -l 2>/dev/null | grep -v "sync-sessions" | grep -v "handoff-worker")

# sync-sessions every 2 min
[ -f "$REPO_DIR/scripts/sync-sessions.js" ] &&   NEW_CRON="$NEW_CRON
*/2 * * * * $NODE_BIN $REPO_DIR/scripts/sync-sessions.js >> /tmp/fleet-sync.log 2>&1"

# handoff-worker every 1 min
[ -f "$REPO_DIR/scripts/handoff-worker.js" ] &&   NEW_CRON="$NEW_CRON
*/1 * * * * $REPO_DIR/scripts/run-handoff-worker.sh >> /tmp/fleet-handoff-worker.log 2>&1"

echo "$NEW_CRON" | crontab -
success "Cron jobs installed:"
info "  sync-sessions  → every 2 min"
info "  handoff-worker → every 1 min"

# ── Start everything ──────────────────────────────────────────────────────────
info "Starting fleet..."
bash "$FLEET_SCRIPT" start all

echo ""
echo "============================================="
success "Deploy complete! 🚀"
echo "============================================="
echo ""
echo "  Status:    fleet status"
echo "  Logs:      tail -f /tmp/fleet-*.log"
echo "  Proxy:     http://localhost:20000"
echo "  Dashboard: http://localhost:20099"
echo ""
echo "  ⚠️  GCP Firewall: open ports 20000, 20099 in VPC firewall rules"
echo "     (or use nginx reverse proxy + HTTPS — recommended for production)"
echo ""
echo "  Deploy log: $DEPLOY_LOG"
