#!/usr/bin/env bash
# Auto-restart wrapper for dashboard
DASHBOARD=/home/dev-user/Projects/oc-fleet/dashboard/server.js
export DATABASE_URL="postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev"

while true; do
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting dashboard..."
  node "$DASHBOARD" >> /tmp/fleet-dashboard.log 2>&1
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Dashboard exited — restarting in 3s..."
  sleep 3
done
