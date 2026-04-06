#!/usr/bin/env bash
# =============================================================================
# oc-fleet — Proxmox VM Deploy Script
# Replicates the local macOS setup on a fresh Ubuntu/Debian Proxmox VM
#
# Usage:
#   1. Clone the repo:  git clone https://github.com/dudezki/oc-fleet.git
#   2. Copy .env:       cp .env.example .env   (fill in secrets)
#   3. Run:             bash scripts/deploy-proxmox.sh
#
# What it does:
#   - Installs Node.js 24, Docker, OpenClaw
#   - Starts PostgreSQL (pgvector) in Docker on port 5433
#   - Runs DB schema migration
#   - Installs proxy, dashboard, google-auth-proxy deps
#   - Creates OpenClaw instance dirs for all 5 agents
#   - Sets up fleet.sh + sync-sessions cron
#   - Starts everything
# =============================================================================

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_LOG="/tmp/fleet-deploy.log"
exec > >(tee -a "$DEPLOY_LOG") 2>&1

# ── Colors ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Load .env ───────────────────────────────────────────────────────────────
ENV_FILE="$REPO_DIR/.env"
[ -f "$ENV_FILE" ] || die ".env not found at $ENV_FILE — copy .env.example and fill in secrets"
set -a; source "$ENV_FILE"; set +a
success "Loaded .env"

# ── Required vars check ─────────────────────────────────────────────────────
REQUIRED_VARS=(
  ANTHROPIC_API_KEY
  GEMINI_API_KEY
  GATEWAY_TOKEN_SALES
  GATEWAY_TOKEN_SUPPORT
  GATEWAY_TOKEN_MANAGER
)
for var in "${REQUIRED_VARS[@]}"; do
  [ -n "${!var:-}" ] || die "Missing required env var: $var"
done

# Set defaults for optional tokens
GATEWAY_TOKEN_DEV="${GATEWAY_TOKEN_DEV:-$(openssl rand -hex 32)}"
GATEWAY_TOKEN_IT="${GATEWAY_TOKEN_IT:-$(openssl rand -hex 32)}"
GATEWAY_TOKEN_RAG="${GATEWAY_TOKEN_RAG:-$(openssl rand -hex 32)}"

BOT_TOKEN_SALES="${BOT_TOKEN_SALES:-8635294015:AAFJ-Xv6hPuON6I9y0XmTCS824HtnIZGHkU}"
BOT_TOKEN_SUPPORT="${BOT_TOKEN_SUPPORT:-8704189878:AAENJYhtN7824JJ29W5MHwitmz7xmXIslGM}"
BOT_TOKEN_MANAGER="${BOT_TOKEN_MANAGER:-8466627149:AAG-tSQhzFMIiggvlj8r4VwtE9TyXUL7Dlg}"
BOT_TOKEN_DEV="${BOT_TOKEN_DEV:-8711513128:AAG1rumx-ragdgt5MnibQHpGJ-YJZv_fltc}"
BOT_TOKEN_IT="${BOT_TOKEN_IT:-8573728913:AAGfKvlnO2yb2Oa2oVLXJTtShJQtEkDuHX0}"

ORG_ID="${ORG_ID:-f86d92cb-db10-43ff-9ff2-d69c319d272d}"

# ── System deps ─────────────────────────────────────────────────────────────
info "Updating system packages..."
sudo apt-get update -qq

# Required tools
for pkg in curl wget git unzip openssl ca-certificates gnupg lsb-release; do
  dpkg -l "$pkg" &>/dev/null || sudo apt-get install -y -qq "$pkg"
done
success "System packages ready"

# ── Node.js 24 ──────────────────────────────────────────────────────────────
if ! node --version 2>/dev/null | grep -q "v24"; then
  info "Installing Node.js 24..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
  success "Node.js $(node --version) installed"
else
  success "Node.js $(node --version) already installed"
fi

# ── OpenClaw ────────────────────────────────────────────────────────────────
if ! command -v openclaw &>/dev/null; then
  info "Installing OpenClaw..."
  sudo npm install -g openclaw
  success "OpenClaw $(openclaw --version 2>/dev/null || echo 'installed')"
else
  success "OpenClaw already installed"
fi

# ── PostgreSQL 16 + pgvector (native — no Docker needed) ────────────────────
# Designed for Proxmox VMs and LXC containers where Docker is unavailable.
PG_PORT=5433
PG_PASS="${PG_PASSWORD:-fleetdev}"
PG_DB="${PG_DATABASE:-fleet_dev}"
PG_USER="${PG_USER:-postgres}"
DB_URL_LOCAL="postgresql://$PG_USER:$PG_PASS@127.0.0.1:$PG_PORT/$PG_DB"

if ! command -v psql &>/dev/null; then
  info "Installing PostgreSQL 16..."
  sudo apt-get install -y curl ca-certificates
  sudo install -d /usr/share/postgresql-common/pgdg
  curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc
  sudo sh -c 'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
    https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list'
  sudo apt-get update -qq
  sudo apt-get install -y postgresql-16 postgresql-16-pgvector
  success "PostgreSQL 16 + pgvector installed"
else
  success "PostgreSQL already installed: $(psql --version)"
fi

# Configure custom port if not default
PG_CONF=$(sudo -u postgres psql -t -c "SHOW config_file;" 2>/dev/null | xargs)
if [ -n "$PG_CONF" ]; then
  CURRENT_PORT=$(sudo -u postgres psql -t -c "SHOW port;" 2>/dev/null | xargs)
  if [ "$CURRENT_PORT" != "$PG_PORT" ]; then
    info "Configuring PostgreSQL to use port $PG_PORT..."
    sudo sed -i "s/^#*port = .*/port = $PG_PORT/" "$PG_CONF"
    sudo systemctl restart postgresql
    sleep 2
  fi
fi

# Ensure PostgreSQL is running
sudo systemctl enable postgresql --now 2>/dev/null || true
for i in $(seq 1 15); do
  sudo -u postgres pg_isready -q 2>/dev/null && break
  sleep 1
done
sudo -u postgres pg_isready -q || die "PostgreSQL failed to start"
success "PostgreSQL running on port $PG_PORT"

# Create DB + user + enable pgvector
info "Setting up database: $PG_DB..."
sudo -u postgres psql -p "$PG_PORT" <<SQL 2>/dev/null || true
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$PG_USER') THEN
    CREATE USER $PG_USER WITH SUPERUSER PASSWORD '$PG_PASS';
  ELSE
    ALTER USER $PG_USER WITH PASSWORD '$PG_PASS';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE $PG_DB' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$PG_DB')\\gexec
SQL
sudo -u postgres psql -p "$PG_PORT" -d "$PG_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || true
success "Database ready: $PG_DB"

# Update pg_hba.conf to allow password auth on localhost
PG_HBA=$(sudo -u postgres psql -p "$PG_PORT" -t -c "SHOW hba_file;" 2>/dev/null | xargs)
if [ -n "$PG_HBA" ]; then
  if ! grep -q "host.*$PG_DB.*$PG_USER.*127.0.0.1" "$PG_HBA" 2>/dev/null; then
    echo "host    $PG_DB    $PG_USER    127.0.0.1/32    md5" | sudo tee -a "$PG_HBA" > /dev/null
    sudo systemctl reload postgresql
  fi
fi

# ── DB Migration ────────────────────────────────────────────────────────────
SCHEMA_FILE="$REPO_DIR/schema/fleet-rag-schema-migration.sql"
if [ -f "$SCHEMA_FILE" ]; then
  info "Running DB schema migration..."
  PGPASSWORD="$PG_PASS" psql -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -f "$SCHEMA_FILE" \
    && success "Schema migration complete" \
    || warn "Schema migration had errors (may be safe if tables already exist)"
else
  warn "Schema file not found at $SCHEMA_FILE — skipping migration"
fi

# ── Install Node.js deps ─────────────────────────────────────────────────────
install_deps() {
  local dir="$1" label="$2"
  if [ -f "$dir/package.json" ]; then
    info "Installing deps: $label"
    npm install --prefix "$dir" --omit=dev --silent
    success "$label deps installed"
  fi
}

install_deps "$REPO_DIR/proxy"            "fleet-proxy"
install_deps "$REPO_DIR/google-auth-proxy" "google-auth-proxy"

# Dashboard lives in a sibling repo by default; adapt path if bundled
DASHBOARD_DIR="${DASHBOARD_DIR:-$(dirname "$REPO_DIR")/cbfleet-dashboard}"
if [ -d "$DASHBOARD_DIR" ]; then
  install_deps "$DASHBOARD_DIR" "cbfleet-dashboard"
  DASHBOARD_JS="$DASHBOARD_DIR/server.js"
else
  warn "Dashboard dir not found at $DASHBOARD_DIR — skipping (set DASHBOARD_DIR env var to override)"
  DASHBOARD_JS=""
fi

# ── Create OpenClaw instance dirs ────────────────────────────────────────────
create_instance() {
  local name="$1"
  local port="$2"
  local hooks_token="$3"   # unified token — used for both OpenClaw gateway auth AND handoff worker
  local bot_token="$4"
  local agent_name="$5"
  local model="${6:-claude-sonnet-4-6}"

  local home="$HOME/cbfleet-rag-$name"
  local oc_dir="$home/.openclaw"

  info "Setting up instance: $agent_name ($home)"
  mkdir -p "$oc_dir/identity" "$oc_dir/workspace"

  # openclaw.json
  cat > "$oc_dir/openclaw.json" <<EOF
{
  "gateway": {
    "port": $port,
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "$hooks_token"
    }
  },
  "auth": {
    "profiles": {
      "anthropic:default": {
        "provider": "anthropic",
        "mode": "token"
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "name": "$agent_name",
        "model": "$model"
      }
    ],
    "defaults": {
      "timeoutSeconds": 300
    }
  },
  "tools": {
    "exec": {
      "host": "gateway",
      "security": "full",
      "ask": "off"
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "open",
      "allowFrom": ["*"],
      "groupPolicy": "open",
      "streaming": "partial",
      "defaultAccount": "default",
      "accounts": {
        "default": {
          "botToken": "$bot_token",
          "dmPolicy": "open",
          "allowFrom": ["*"],
          "groups": {
            "*": { "requireMention": false }
          },
          "streaming": "partial",
          "actions": { "reactions": true }
        }
      }
    }
  },
  "session": {
    "dmScope": "main"
  }
}
EOF

  # auth-profiles.json (Anthropic key)
  cat > "$oc_dir/identity/auth-profiles.json" <<EOF
{
  "version": 1,
  "profiles": {
    "anthropic:default": {
      "type": "token",
      "provider": "anthropic",
      "token": "$ANTHROPIC_API_KEY"
    }
  },
  "lastGood": {
    "anthropic": "anthropic:default"
  }
}
EOF

  # Copy SOUL.md from instances dir if exists
  local soul_src="$REPO_DIR/instances/$name/SOUL.md"
  if [ -f "$soul_src" ]; then
    cp "$soul_src" "$oc_dir/workspace/SOUL.md"
  fi

  # Write auth-profiles to agent dir too (OpenClaw looks here at runtime)
  mkdir -p "$oc_dir/agents/main/agent"
  cp "$oc_dir/identity/auth-profiles.json" "$oc_dir/agents/main/agent/auth-profiles.json"

  # Upsert agent into DB with hooks_token + gateway_token unified
  PGPASSWORD="${PG_PASS}" psql -h 127.0.0.1 -p "${PG_PORT}" -U "${PG_USER}" -d "${PG_DB}" <<SQL 2>/dev/null || true
    INSERT INTO fleet.agents (org_id, name, slug, status, config, bot_token, gateway_port, gateway_token, hooks_token)
    VALUES (
      '${ORG_ID}', '${agent_name}', '${name}', 'active',
      '{"meta": {"emoji": "🤖", "model": "${model}", "provider": "anthropic", "port": ${port}}}'::jsonb,
      '${bot_token}', ${port}, '${hooks_token}', '${hooks_token}'
    )
    ON CONFLICT DO NOTHING;
    UPDATE fleet.agents
    SET gateway_token='${hooks_token}', hooks_token='${hooks_token}', gateway_port=${port}, bot_token='${bot_token}'
    WHERE slug='${name}' AND org_id='${ORG_ID}';
SQL

  success "  $agent_name → port $port (hooks_token set)"
}

create_instance "sales"   20010 "$GATEWAY_TOKEN_SALES"   "$BOT_TOKEN_SALES"   "Fleet-Sales"   "claude-sonnet-4-6"
create_instance "support" 20020 "$GATEWAY_TOKEN_SUPPORT" "$BOT_TOKEN_SUPPORT" "Fleet-Support" "claude-sonnet-4-6"
create_instance "manager" 20030 "$GATEWAY_TOKEN_MANAGER" "$BOT_TOKEN_MANAGER" "Fleet-Manager" "claude-sonnet-4-6"
create_instance "dev"     20040 "$GATEWAY_TOKEN_DEV"     "$BOT_TOKEN_DEV"     "Fleet-Dev"     "claude-sonnet-4-6"
create_instance "it"      20050 "$GATEWAY_TOKEN_IT"      "$BOT_TOKEN_IT"      "Fleet-IT"      "claude-haiku-4-5"

# ── Write fleet.sh with correct paths ───────────────────────────────────────
info "Writing fleet.sh for this environment..."
FLEET_SCRIPT="$HOME/fleet.sh"

cat > "$FLEET_SCRIPT" <<FLEET_EOF
#!/usr/bin/env bash
# Fleet management — auto-generated by deploy-proxmox.sh

cmd="\${1:-status}"
target="\${2:-all}"

port_for()   { case \$1 in sales) echo 20010;; support) echo 20020;; manager) echo 20030;; dev) echo 20040;; it) echo 20050;; esac; }
home_for()   { echo "\$HOME/cbfleet-rag-\$1"; }
instances()  { [ "\$target" = "all" ] && echo "sales support manager dev it" || echo "\$target"; }

PROXY_PORT=20000
PROXY_JS=$REPO_DIR/proxy/server.js
DASHBOARD_PORT=20099
DASHBOARD_JS=${DASHBOARD_JS:-/nonexistent/dashboard.js}
GOOGLE_AUTH_PORT=19001
GOOGLE_AUTH_JS=$REPO_DIR/google-auth-proxy/server.js

start_proxy() {
  fuser -k \$PROXY_PORT/tcp 2>/dev/null; sleep 0.5
  set -a; [ -f "$REPO_DIR/.env" ] && source "$REPO_DIR/.env"; set +a
  DATABASE_URL="$DB_URL_LOCAL" node "\$PROXY_JS" > /tmp/fleet-proxy.log 2>&1 &
  echo \$! > /tmp/fleet-proxy.pid
  sleep 1
  r=\$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:\$PROXY_PORT/fleet-api/retrieve \
    -H "Content-Type: application/json" \
    -d '{"org_id":"$ORG_ID"}' 2>/dev/null)
  [ "\$r" = "200" ] && echo "  ✅ proxy up (:\$PROXY_PORT)" || echo "  ❌ proxy failed — check /tmp/fleet-proxy.log"
}

stop_proxy() {
  [ -f /tmp/fleet-proxy.pid ] && kill "\$(cat /tmp/fleet-proxy.pid)" 2>/dev/null; rm -f /tmp/fleet-proxy.pid
  fuser -k \$PROXY_PORT/tcp 2>/dev/null; echo "⏹  Stopped proxy"
}

start_dashboard() {
  [ -z "\$DASHBOARD_JS" ] || [ ! -f "\$DASHBOARD_JS" ] && { echo "  ⚠️  Dashboard not configured"; return; }
  fuser -k \$DASHBOARD_PORT/tcp 2>/dev/null; sleep 0.5
  DATABASE_URL="$DB_URL_LOCAL" node "\$DASHBOARD_JS" > /tmp/fleet-dashboard.log 2>&1 &
  echo \$! > /tmp/fleet-dashboard.pid; sleep 1
  r=\$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:\$DASHBOARD_PORT/api/status 2>/dev/null)
  [ "\$r" = "200" ] && echo "  ✅ dashboard up (:\$DASHBOARD_PORT)" || echo "  ❌ dashboard failed — check /tmp/fleet-dashboard.log"
}

stop_dashboard() {
  [ -f /tmp/fleet-dashboard.pid ] && kill "\$(cat /tmp/fleet-dashboard.pid)" 2>/dev/null; rm -f /tmp/fleet-dashboard.pid
  fuser -k \$DASHBOARD_PORT/tcp 2>/dev/null; echo "⏹  Stopped dashboard"
}

start_google_auth() {
  fuser -k \$GOOGLE_AUTH_PORT/tcp 2>/dev/null; sleep 0.5
  DATABASE_URL="$DB_URL_LOCAL" node "\$GOOGLE_AUTH_JS" > /tmp/fleet-google-auth.log 2>&1 &
  echo \$! > /tmp/fleet-google-auth.pid; sleep 2
  r=\$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:\$GOOGLE_AUTH_PORT/health 2>/dev/null)
  [ "\$r" = "200" ] && echo "  ✅ google-auth up (:\$GOOGLE_AUTH_PORT)" || echo "  ❌ google-auth failed — check /tmp/fleet-google-auth.log"
}

stop_google_auth() {
  [ -f /tmp/fleet-google-auth.pid ] && kill "\$(cat /tmp/fleet-google-auth.pid)" 2>/dev/null; rm -f /tmp/fleet-google-auth.pid
  fuser -k \$GOOGLE_AUTH_PORT/tcp 2>/dev/null; echo "⏹  Stopped google-auth"
}

start_instance() {
  local inst=\$1 port home
  port=\$(port_for "\$inst"); home=\$(home_for "\$inst")
  echo "▶ Starting \$inst on :\$port"
  OPENCLAW_HOME="\$home" openclaw gateway run --port "\$port" --force > /tmp/fleet-\$inst.log 2>&1 &
  echo \$! > /tmp/fleet-\$inst.pid; sleep 5
  r=\$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:\$port/health 2>/dev/null)
  [ "\$r" = "200" ] && echo "  ✅ \$inst up (:\$port)" || echo "  ❌ \$inst failed — check /tmp/fleet-\$inst.log"
}

stop_instance() {
  local inst=\$1 port pid_file
  port=\$(port_for "\$inst"); pid_file=/tmp/fleet-\$inst.pid
  [ -f "\$pid_file" ] && kill "\$(cat \$pid_file)" 2>/dev/null; rm -f "\$pid_file"
  fuser -k \$port/tcp 2>/dev/null && echo "⏹  Stopped \$inst (:\$port)" || echo "   \$inst not running"
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
  start)
    [ "\$target" = "all" ] && { start_proxy; start_dashboard; start_google_auth; }
    for inst in \$(instances); do start_instance "\$inst"; done ;;
  stop)
    for inst in \$(instances); do stop_instance "\$inst"; done
    [ "\$target" = "all" ] && { stop_proxy; stop_dashboard; stop_google_auth; } ;;
  restart)
    for inst in \$(instances); do stop_instance "\$inst"; done
    [ "\$target" = "all" ] && { stop_proxy; stop_dashboard; stop_google_auth; sleep 1; start_proxy; start_dashboard; start_google_auth; }
    sleep 1
    for inst in \$(instances); do start_instance "\$inst"; done ;;
  proxy)     stop_proxy; start_proxy ;;
  dashboard) stop_dashboard; start_dashboard ;;
  status)    status_all ;;
  *)
    echo "Usage: fleet.sh [start|stop|restart|proxy|dashboard|status] [sales|support|manager|dev|it|all]" ;;
esac
FLEET_EOF

chmod +x "$FLEET_SCRIPT"
ln -sf "$FLEET_SCRIPT" /usr/local/bin/fleet 2>/dev/null || true
success "fleet.sh written → ~/fleet.sh (also available as 'fleet' command)"

# ── Sync sessions cron ───────────────────────────────────────────────────────
SYNC_SCRIPT="$REPO_DIR/scripts/sync-sessions.js"
if [ -f "$SYNC_SCRIPT" ]; then
  info "Setting up sync-sessions cron (every 2 min)..."
  CRON_LINE="*/2 * * * * node $SYNC_SCRIPT >> /tmp/fleet-sync.log 2>&1"
  (crontab -l 2>/dev/null | grep -v "sync-sessions"; echo "$CRON_LINE") | crontab -
  success "Sync cron installed"
else
  warn "sync-sessions.js not found — skipping cron setup"
fi

# ── Start everything ─────────────────────────────────────────────────────────
info "Starting fleet..."
bash "$FLEET_SCRIPT" start all

echo ""
echo "============================================="
success "Deploy complete! 🚀"
echo "============================================="
echo ""
echo "  Status:    fleet status"
echo "  Logs:      tail -f /tmp/fleet-*.log"
echo "  Proxy:     http://127.0.0.1:20000"
echo "  Dashboard: http://127.0.0.1:20099"
echo ""
echo "  Deploy log: $DEPLOY_LOG"
