#!/usr/bin/env bash
# Fleet management script
export PATH="/usr/bin:$PATH"
# Usage:
#   ./fleet.sh start   [sales|support|manager|dev|it|all]
#   ./fleet.sh stop    [sales|support|manager|dev|it|all]
#   ./fleet.sh restart [sales|support|manager|dev|it|all]
#   ./fleet.sh status

cmd="${1:-status}"
target="${2:-all}"

port_for()   { case $1 in sales) echo 20010;; support) echo 20020;; manager) echo 20030;; dev) echo 20040;; it) echo 20050;; hr) echo 20060;; finance) echo 20070;; security) echo 20080;; documentor) echo 20090;; esac; }
home_for()   { echo "$HOME/cbfleet-rag-$1"; }
instances()  { [ "$target" = "all" ] && echo "sales support manager dev it hr finance security documentor" || echo "$target"; }

PROXY_PORT=20000
PROXY_JS=/home/dev-user/Projects/oc-fleet/proxy/server.js
REPO_DIR=/home/dev-user/Projects/oc-fleet
DB_URL="postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev"
ORG_ID="f86d92cb-db10-43ff-9ff2-d69c319d272d"

DASHBOARD_PORT=20099
DASHBOARD_JS=/home/dev-user/Projects/oc-fleet/dashboard/server.js

AEGIS_PORT=30000
AEGIS_HOME=/home/dev-user/aegis

GOOGLE_AUTH_PORT=19001
GOOGLE_AUTH_JS=/home/dev-user/Projects/oc-fleet/google-auth-proxy/server.js

HUBSPOT_OAUTH_PORT=19002
HUBSPOT_OAUTH_JS=/home/dev-user/Projects/oc-fleet/hubspot-oauth/server.js
HUBSPOT_PROXY_PORT=19003
HUBSPOT_PROXY_JS=/home/dev-user/Projects/oc-fleet/hubspot-proxy/server.js

start_dashboard() {
  kill $(lsof -ti :$DASHBOARD_PORT) 2>/dev/null; sleep 0.5
  node "$DASHBOARD_JS" > /tmp/fleet-dashboard.log 2>&1 &
  echo $! > /tmp/fleet-dashboard.pid
  sleep 1
  local r; r=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$DASHBOARD_PORT/api/status 2>/dev/null)
  [ "$r" = "200" ] && echo "  ✅ dashboard up (:$DASHBOARD_PORT)" || echo "  ❌ dashboard failed — check /tmp/fleet-dashboard.log"
}

stop_dashboard() {
  [ -f /tmp/fleet-dashboard.pid ] && kill "$(cat /tmp/fleet-dashboard.pid)" 2>/dev/null && rm -f /tmp/fleet-dashboard.pid
  kill $(lsof -ti :$DASHBOARD_PORT) 2>/dev/null
  echo "⏹  Stopped dashboard"
}

start_handoff_worker() {
  [ -f /tmp/fleet-handoff-worker.pid ] && kill "$(cat /tmp/fleet-handoff-worker.pid)" 2>/dev/null; rm -f /tmp/fleet-handoff-worker.pid
  WORKER_DAEMON=1 WORKER_INTERVAL_MS=15000 \
  DATABASE_URL="$DB_URL" ORG_ID="$ORG_ID" \
  node "$REPO_DIR/scripts/handoff-worker.js" >> /tmp/fleet-handoff-worker.log 2>&1 &
  echo $! > /tmp/fleet-handoff-worker.pid
  sleep 1
  kill -0 "$(cat /tmp/fleet-handoff-worker.pid)" 2>/dev/null \
    && echo "  ✅ handoff-worker up (15s interval)" \
    || echo "  ❌ handoff-worker failed — check /tmp/fleet-handoff-worker.log"
}

stop_handoff_worker() {
  [ -f /tmp/fleet-handoff-worker.pid ] && kill "$(cat /tmp/fleet-handoff-worker.pid)" 2>/dev/null; rm -f /tmp/fleet-handoff-worker.pid
  echo "⏹  Stopped handoff-worker"
}

start_google_auth() {
  lsof -ti :$GOOGLE_AUTH_PORT | xargs kill -9 2>/dev/null; sleep 0.5
  GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID}" \
  GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET}" \
  GOOGLE_REDIRECT_URI="${GOOGLE_REDIRECT_URI:-https://YOUR_VM_DOMAIN/google-auth/callback}" \
  TOKEN_STORE_DIR="${HOME}/.callbox-google-tokens" \
  node "$GOOGLE_AUTH_JS" > /tmp/fleet-google-auth.log 2>&1 &
  echo $! > /tmp/fleet-google-auth.pid
  sleep 2
  local r; r=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$GOOGLE_AUTH_PORT/health 2>/dev/null)
  [ "$r" = "200" ] && echo "  ✅ google-auth up (:$GOOGLE_AUTH_PORT)" || echo "  ❌ google-auth failed — check /tmp/fleet-google-auth.log"
}

stop_google_auth() {
  [ -f /tmp/fleet-google-auth.pid ] && kill "$(cat /tmp/fleet-google-auth.pid)" 2>/dev/null && rm -f /tmp/fleet-google-auth.pid
  lsof -ti :$GOOGLE_AUTH_PORT | xargs kill -9 2>/dev/null
  echo "⏹  Stopped google-auth"
}

start_hubspot_oauth() {
  lsof -ti :$HUBSPOT_OAUTH_PORT | xargs kill -9 2>/dev/null; sleep 0.5
  HUBSPOT_CLIENT_ID="${HUBSPOT_CLIENT_ID}" \
  HUBSPOT_CLIENT_SECRET="${HUBSPOT_CLIENT_SECRET}" \
  HUBSPOT_REDIRECT_URI="${HUBSPOT_REDIRECT_URI}" \
  TOKEN_STORE_DIR="${TOKEN_STORE_DIR:-$HOME/.callbox-hubspot-tokens}" \
  node "$HUBSPOT_OAUTH_JS" > /tmp/fleet-hubspot-oauth.log 2>&1 &
  echo $! > /tmp/fleet-hubspot-oauth.pid
  sleep 2
  local r; r=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$HUBSPOT_OAUTH_PORT/health 2>/dev/null)
  [ "$r" = "200" ] && echo "  ✅ hubspot-oauth up (:$HUBSPOT_OAUTH_PORT)" || echo "  ❌ hubspot-oauth failed — check /tmp/fleet-hubspot-oauth.log"
}

stop_hubspot_oauth() {
  [ -f /tmp/fleet-hubspot-oauth.pid ] && kill "$(cat /tmp/fleet-hubspot-oauth.pid)" 2>/dev/null && rm -f /tmp/fleet-hubspot-oauth.pid
  lsof -ti :$HUBSPOT_OAUTH_PORT | xargs kill -9 2>/dev/null
  echo "⏹  Stopped hubspot-oauth"
}

start_hubspot_proxy() {
  lsof -ti :$HUBSPOT_PROXY_PORT | xargs kill -9 2>/dev/null; sleep 0.5
  HUBSPOT_ADMIN_TOKEN_MARKETING_CRM="${HUBSPOT_ADMIN_TOKEN_MARKETING_CRM}" \
  HUBSPOT_ADMIN_TOKEN_ONE_CRM="${HUBSPOT_ADMIN_TOKEN_ONE_CRM}" \
  ROUTING_TABLE_PATH="${ROUTING_TABLE_PATH}" \
  PROXY_DIR="/home/dev-user/Projects/oc-fleet/hubspot-proxy" \
  node "$HUBSPOT_PROXY_JS" > /tmp/fleet-hubspot-proxy.log 2>&1 &
  echo $! > /tmp/fleet-hubspot-proxy.pid
  sleep 2
  local r; r=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$HUBSPOT_PROXY_PORT/health 2>/dev/null)
  [ "$r" = "200" ] && echo "  ✅ hubspot-proxy up (:$HUBSPOT_PROXY_PORT)" || echo "  ❌ hubspot-proxy failed — check /tmp/fleet-hubspot-proxy.log"
}

stop_hubspot_proxy() {
  [ -f /tmp/fleet-hubspot-proxy.pid ] && kill "$(cat /tmp/fleet-hubspot-proxy.pid)" 2>/dev/null && rm -f /tmp/fleet-hubspot-proxy.pid
  lsof -ti :$HUBSPOT_PROXY_PORT | xargs kill -9 2>/dev/null
  echo "⏹  Stopped hubspot-proxy"
}

start_aegis() {
  lsof -ti :$AEGIS_PORT | xargs kill -9 2>/dev/null; sleep 0.5
  OPENCLAW_HOME="$AEGIS_HOME" /usr/bin/openclaw gateway run --port $AEGIS_PORT --force > /tmp/aegis.log 2>&1 &
  echo $! > /tmp/aegis.pid
  sleep 5
  local r; r=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$AEGIS_PORT/health 2>/dev/null)
  [ "$r" = "200" ] && echo "  ✅ aegis up (:$AEGIS_PORT)" || echo "  ❌ aegis failed — check /tmp/aegis.log"
}

stop_aegis() {
  [ -f /tmp/aegis.pid ] && kill "$(cat /tmp/aegis.pid)" 2>/dev/null && rm -f /tmp/aegis.pid
  lsof -ti :$AEGIS_PORT | xargs kill -9 2>/dev/null
  echo "⏹  Stopped aegis"
}

OLLAMA_API_KEY=35cfcba4cacf440183df3817186968b9.XU4XLsp7nNVBabSjyK22mPFq
export OLLAMA_API_KEY

start_proxy() {
  lsof -ti :$PROXY_PORT | xargs kill -9 2>/dev/null; sleep 0.5
  # Source .env for API keys
  set -a; [ -f "$(dirname "$PROXY_JS")/../.env" ] && source "$(dirname "$PROXY_JS")/../.env"; set +a
  node "$PROXY_JS" > /tmp/fleet-proxy.log 2>&1 &
  echo $! > /tmp/fleet-proxy.pid
  sleep 1
  local r; r=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:$PROXY_PORT/fleet-api/retrieve \
    -H "Content-Type: application/json" \
    -d '{"org_id":"f86d92cb-db10-43ff-9ff2-d69c319d272d"}' 2>/dev/null)
  [ "$r" = "200" ] && echo "  ✅ proxy up (:$PROXY_PORT)" || echo "  ❌ proxy failed — check /tmp/fleet-proxy.log"
}

stop_proxy() {
  local pid_file=/tmp/fleet-proxy.pid
  if [ -f "$pid_file" ]; then
    kill "$(cat $pid_file)" 2>/dev/null; rm -f "$pid_file"
  fi
  lsof -ti :$PROXY_PORT | xargs kill -9 2>/dev/null
  echo "⏹  Stopped proxy"
}

start_instance() {
  local inst=$1 port home
  port=$(port_for "$inst"); home=$(home_for "$inst")
  echo "▶ Starting $inst on :$port"
  # Source .env for API keys (Gemini, Anthropic etc)
  set -a; [ -f "$REPO_DIR/.env" ] && source "$REPO_DIR/.env"; set +a
  OPENCLAW_HOME="$home" openclaw gateway run --port "$port" --force > /tmp/fleet-$inst.log 2>&1 &
  echo $! > /tmp/fleet-$inst.pid
  sleep 5
  local r; r=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$port/health 2>/dev/null)
  [ "$r" = "200" ] && echo "  ✅ $inst up (:$port)" || echo "  ❌ $inst failed — check /tmp/fleet-$inst.log"
}

stop_instance() {
  local inst=$1 port pid_file
  port=$(port_for "$inst"); pid_file=/tmp/fleet-$inst.pid
  if [ -f "$pid_file" ]; then
    kill "$(cat "$pid_file")" 2>/dev/null
    rm -f "$pid_file"
    echo "⏹  Stopped $inst"
  else
    kill "$(lsof -ti :$port 2>/dev/null)" 2>/dev/null && echo "⏹  Stopped $inst (:$port)" || echo "   $inst not running"
  fi
}

status_all() {
  echo "=== Fleet Status ==="
  for inst in sales support manager dev it hr finance security documentor; do
    local port r
    port=$(port_for "$inst")
    r=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$port/health 2>/dev/null)
    [ "$r" = "200" ] && echo "  ✅ $inst   :$port" || echo "  ❌ $inst   :$port  (down)"
  done
  local rp
  rp=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:20000/fleet-api/retrieve \
    -H "Content-Type: application/json" \
    -d '{"org_id":"f86d92cb-db10-43ff-9ff2-d69c319d272d"}' 2>/dev/null)
  [ "$rp" = "200" ] && echo "  ✅ proxy     :20000" || echo "  ❌ proxy     :20000  (down)"
  local rd
  rd=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:20099/api/status 2>/dev/null)
  [ "$rd" = "200" ] && echo "  ✅ dashboard :20099" || echo "  ❌ dashboard :20099  (down)"
  local ra
  ra=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$AEGIS_PORT/health 2>/dev/null)
  [ "$ra" = "200" ] && echo "  ✅ aegis      :$AEGIS_PORT" || echo "  ❌ aegis      :$AEGIS_PORT  (down)"
  local rg
  rg=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$GOOGLE_AUTH_PORT/health 2>/dev/null)
  [ "$rg" = "200" ] && echo "  ✅ google-auth :$GOOGLE_AUTH_PORT" || echo "  ❌ google-auth :$GOOGLE_AUTH_PORT  (down)"
  local rho
  rho=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$HUBSPOT_OAUTH_PORT/health 2>/dev/null)
  [ "$rho" = "200" ] && echo "  ✅ hubspot-oauth :$HUBSPOT_OAUTH_PORT" || echo "  ❌ hubspot-oauth :$HUBSPOT_OAUTH_PORT  (down)"
  local rhp
  rhp=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$HUBSPOT_PROXY_PORT/health 2>/dev/null)
  [ "$rhp" = "200" ] && echo "  ✅ hubspot-proxy :$HUBSPOT_PROXY_PORT" || echo "  ❌ hubspot-proxy :$HUBSPOT_PROXY_PORT  (down)"
}

case "$cmd" in
  start)
    [ "$target" = "all" ] && { start_proxy; start_dashboard; start_google_auth; start_hubspot_oauth; start_hubspot_proxy; start_aegis; start_handoff_worker; }
    for inst in $(instances); do start_instance "$inst"; done ;;
  stop)
    for inst in $(instances); do stop_instance "$inst"; done
    [ "$target" = "all" ] && { stop_proxy; stop_dashboard; stop_google_auth; stop_hubspot_oauth; stop_hubspot_proxy; stop_aegis; stop_handoff_worker; } ;;
  restart)
    for inst in $(instances); do stop_instance "$inst"; done
    [ "$target" = "all" ] && { stop_proxy; stop_dashboard; stop_google_auth; stop_hubspot_oauth; stop_hubspot_proxy; stop_aegis; stop_handoff_worker; sleep 1; start_proxy; start_dashboard; start_google_auth; start_hubspot_oauth; start_hubspot_proxy; start_aegis; start_handoff_worker; }
    sleep 1
    for inst in $(instances); do start_instance "$inst"; done ;;
  proxy)          stop_proxy; start_proxy ;;
  dashboard)      stop_dashboard; start_dashboard ;;
  aegis)          stop_aegis; start_aegis ;;
  google-auth)    stop_google_auth; start_google_auth ;;
  hubspot-oauth)  stop_hubspot_oauth; start_hubspot_oauth ;;
  hubspot-proxy)  stop_hubspot_proxy; start_hubspot_proxy ;;
  status)      status_all ;;
  *)
    echo "Usage: fleet.sh [start|stop|restart|proxy|dashboard|status] [sales|support|manager|all]" ;;
esac
