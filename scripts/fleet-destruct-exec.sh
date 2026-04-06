#!/bin/bash
# ============================================================
#  CB Fleet V2 — Self-Destruct Executor (no-prompt version)
#  Called by the webhook — runs silently, no countdown.
#  DO NOT expose this directly. Webhook validates the code.
# ============================================================

LOG="/tmp/fleet-destruct-$(date +%s).log"
exec >> "$LOG" 2>&1

echo "[$(date -u)] Self-destruct executor started on $(hostname)"

FLEET_SERVICES="cbfleet-proxy cbfleet-sales cbfleet-support cbfleet-manager cbfleet-dev cbfleet-it cbfleet-hr cbfleet-dashboard fleet-destruct-webhook"
FLEET_DB_CONTAINER="cbfleet-db"
NGINX_SITE="cbfleet"
FLEET_HOME="${HOME}/cbfleet"
OPENCLAW_HOME="${HOME}/.openclaw"

# 1. Stop services
for svc in $FLEET_SERVICES; do
  systemctl stop "$svc" 2>/dev/null || true
  systemctl disable "$svc" 2>/dev/null || true
  rm -f "/etc/systemd/system/${svc}.service"
done
systemctl daemon-reload
echo "[1/7] Services stopped"

# 2. Docker
if command -v docker &>/dev/null; then
  docker stop "$FLEET_DB_CONTAINER" 2>/dev/null || true
  docker rm -v "$FLEET_DB_CONTAINER" 2>/dev/null || true
  docker volume prune -f 2>/dev/null || true
  docker images --format "{{.Repository}}:{{.Tag}}" | grep -i "cbfleet\|fleet" | xargs docker rmi -f 2>/dev/null || true
fi
echo "[2/7] Docker cleaned"

# 3. Nginx
rm -f "/etc/nginx/sites-enabled/${NGINX_SITE}" "/etc/nginx/sites-available/${NGINX_SITE}"
nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true
echo "[3/7] Nginx cleaned"

# 4. Fleet files
rm -rf "$FLEET_HOME" 2>/dev/null || true
find /home -maxdepth 2 -name "cbfleet-*" -type d -exec rm -rf {} + 2>/dev/null || true
echo "[4/7] Fleet files removed"

# 5. OpenClaw
rm -rf "$OPENCLAW_HOME" 2>/dev/null || true
find /home -maxdepth 2 -name ".openclaw" -type d -exec rm -rf {} + 2>/dev/null || true
npm uninstall -g openclaw 2>/dev/null || true
echo "[5/7] OpenClaw removed"

# 6. Crontabs
crontab -r 2>/dev/null || true
echo "[6/7] Crontabs cleared"

# 7. Wipe self
rm -f /usr/local/sbin/fleet-destruct
rm -f /usr/local/sbin/fleet-destruct-exec
rm -f /etc/systemd/system/fleet-destruct-webhook.service
echo "[7/7] Kill switch removed"

echo "[$(date -u)] Self-destruct complete on $(hostname)"
# Log will remain at /tmp/fleet-destruct-*.log — remove if you want zero trace:
# rm -f "$LOG"
