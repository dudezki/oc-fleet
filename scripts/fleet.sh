#!/usr/bin/env bash
# Fleet management script
# Usage:
#   ./fleet.sh start   [sales|support|manager|dev|it|all]
#   ./fleet.sh stop    [sales|support|manager|dev|it|all]
#   ./fleet.sh restart [sales|support|manager|dev|it|all]
#   ./fleet.sh status

cmd="${1:-status}"
target="${2:-all}"

port_for()   { case $1 in sales) echo 20010;; support) echo 20020;; manager) echo 20030;; dev) echo 20040;; it) echo 20050;; esac; }
home_for()   { echo "$HOME/cbfleet-rag-$1"; }
instances()  { [ "$target" = "all" ] && echo "sales support manager dev it" || echo "$target"; }

PROXY_PORT=20000
PROXY_JS=/Users/dudezkie/Projects/cbfleet-rag/proxy/server.js

DASHBOARD_PORT=20099
DASHBOARD_JS=/Users/dudezkie/Projects/cbfleet-dashboard/server.js

AEGIS_PORT=30000
AEGIS_HOME=/Users/dudezkie/aegis

GOOGLE_AUTH_PORT=19001
GOOGLE_AUTH_JS=/Users/dudezkie/Projects/cbfleet-rag/google-auth-proxy/server.js

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

start_aegis() {
  lsof -ti :$AEGIS_PORT | xargs kill -9 2>/dev/null; sleep 0.5
  OPENCLAW_HOME="$AEGIS_HOME" /Users/dudezkie/.nvm/versions/node/v24.13.1/bin/openclaw gateway run --port $AEGIS_PORT --force > /tmp/aegis.log 2>&1 &
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
  for inst in sales support manager dev it; do
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
}

case "$cmd" in
  start)
    [ "$target" = "all" ] && { start_proxy; start_dashboard; start_google_auth; start_aegis; }
    for inst in $(instances); do start_instance "$inst"; done ;;
  stop)
    for inst in $(instances); do stop_instance "$inst"; done
    [ "$target" = "all" ] && { stop_proxy; stop_dashboard; stop_google_auth; stop_aegis; } ;;
  restart)
    for inst in $(instances); do stop_instance "$inst"; done
    [ "$target" = "all" ] && { stop_proxy; stop_dashboard; stop_google_auth; stop_aegis; sleep 1; start_proxy; start_dashboard; start_google_auth; start_aegis; }
    sleep 1
    for inst in $(instances); do start_instance "$inst"; done ;;
  proxy)       stop_proxy; start_proxy ;;
  dashboard)   stop_dashboard; start_dashboard ;;
  aegis)       stop_aegis; start_aegis ;;
  google-auth) stop_google_auth; start_google_auth ;;
  status)      status_all ;;
  *)
    echo "Usage: fleet.sh [start|stop|restart|proxy|dashboard|status] [sales|support|manager|all]" ;;
esac
