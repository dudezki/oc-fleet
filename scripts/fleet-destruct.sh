#!/bin/bash
# ============================================================
#  CB Fleet V2 — Self-Destruct Script
#  Usage: ./fleet-destruct.sh <6-digit-code>
#  Keep the code safe. This is irreversible.
# ============================================================

set -euo pipefail

# ── Config ──────────────────────────────────────────────────
# SHA256 hash of the 6-digit code (replace with your own)
# Generate: echo -n "YOUR_CODE" | sha256sum
CODE_HASH="577e236319bbc040c8b81e52579009b82eec61df95c4afec8dd4916250b8fb96"

# Optional: phone-home URL before wipe (leave empty to skip)
# Will POST { "event": "destruct", "host": "...", "at": "..." }
PHONE_HOME_URL=""

# Paths to wipe (adjust for your v2 deployment)
FLEET_HOME="${HOME}/cbfleet"
OPENCLAW_HOME="${HOME}/.openclaw"
FLEET_DB_CONTAINER="cbfleet-db"
FLEET_SERVICES="cbfleet-proxy cbfleet-sales cbfleet-support cbfleet-manager cbfleet-dev cbfleet-it cbfleet-hr cbfleet-dashboard"
NGINX_SITE="cbfleet"

# ── Verify code ─────────────────────────────────────────────
if [ $# -ne 1 ]; then
  echo "Usage: $0 <6-digit-code>"
  exit 1
fi

INPUT_HASH=$(echo -n "$1" | sha256sum | awk '{print $1}')
if [ "$INPUT_HASH" != "$CODE_HASH" ]; then
  echo "Invalid code."
  exit 1
fi

echo ""
echo "  ██████╗ ███████╗███████╗████████╗██████╗ ██╗   ██╗ ██████╗████████╗"
echo "  ██╔══██╗██╔════╝██╔════╝╚══██╔══╝██╔══██╗██║   ██║██╔════╝╚══██╔══╝"
echo "  ██║  ██║█████╗  ███████╗   ██║   ██████╔╝██║   ██║██║        ██║   "
echo "  ██║  ██║██╔══╝  ╚════██║   ██║   ██╔══██╗██║   ██║██║        ██║   "
echo "  ██████╔╝███████╗███████║   ██║   ██║  ██║╚██████╔╝╚██████╗   ██║   "
echo "  ╚═════╝ ╚══════╝╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝  ╚═════╝   ╚═╝  "
echo ""
echo "  CB Fleet V2 — Self-Destruct Initiated"
echo "  Host: $(hostname) | Time: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

# ── Phone home (fire and forget, don't block wipe) ──────────
if [ -n "$PHONE_HOME_URL" ]; then
  curl -s -X POST "$PHONE_HOME_URL" \
    -H "Content-Type: application/json" \
    -d "{\"event\":\"destruct\",\"host\":\"$(hostname)\",\"ip\":\"$(curl -s ifconfig.me 2>/dev/null || echo unknown)\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    --max-time 5 2>/dev/null || true
  echo "[✓] Phone home sent"
fi

# ── 5 second abort window ────────────────────────────────────
echo "  Starting in 5 seconds... Ctrl+C to abort"
for i in 5 4 3 2 1; do
  echo -n "  $i... "
  sleep 1
done
echo ""
echo "  Wiping..."
echo ""

# ── 1. Stop + disable systemd services ──────────────────────
echo "[1/8] Stopping services..."
for svc in $FLEET_SERVICES; do
  sudo systemctl stop "$svc" 2>/dev/null || true
  sudo systemctl disable "$svc" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/${svc}.service"
done
sudo systemctl daemon-reload
echo "      Done"

# ── 2. Stop + remove Docker containers / DB ─────────────────
echo "[2/8] Removing Docker containers..."
if command -v docker &>/dev/null; then
  docker stop $FLEET_DB_CONTAINER 2>/dev/null || true
  docker rm -v $FLEET_DB_CONTAINER 2>/dev/null || true
  docker volume prune -f 2>/dev/null || true
  # Remove fleet-related images
  docker images --format "{{.Repository}}:{{.Tag}}" | grep -i "cbfleet\|fleet" | xargs docker rmi -f 2>/dev/null || true
fi
echo "      Done"

# ── 3. Remove nginx config ───────────────────────────────────
echo "[3/8] Removing nginx config..."
sudo rm -f "/etc/nginx/sites-enabled/${NGINX_SITE}"
sudo rm -f "/etc/nginx/sites-available/${NGINX_SITE}"
sudo nginx -t 2>/dev/null && sudo systemctl reload nginx 2>/dev/null || true
echo "      Done"

# ── 4. Remove fleet application files ───────────────────────
echo "[4/8] Removing fleet application files..."
rm -rf "$FLEET_HOME" 2>/dev/null || true
echo "      Done"

# ── 5. Remove openclaw state ─────────────────────────────────
echo "[5/8] Removing OpenClaw state..."
rm -rf "$OPENCLAW_HOME" 2>/dev/null || true
# Remove all cbfleet agent homes
find "$HOME" -maxdepth 1 -name "cbfleet-*" -type d -exec rm -rf {} + 2>/dev/null || true
echo "      Done"

# ── 6. Remove npm packages ───────────────────────────────────
echo "[6/8] Removing npm packages..."
sudo npm uninstall -g openclaw 2>/dev/null || true
# Remove node_modules in fleet dirs (belt + suspenders)
find "$HOME" -maxdepth 3 -name "node_modules" -type d -exec rm -rf {} + 2>/dev/null || true
echo "      Done"

# ── 7. Clear crontabs ────────────────────────────────────────
echo "[7/8] Clearing crontabs..."
crontab -r 2>/dev/null || true
echo "      Done"

# ── 8. Wipe this script itself ───────────────────────────────
echo "[8/8] Removing self-destruct script..."
SCRIPT_PATH="$(realpath "$0")"
shred -u "$SCRIPT_PATH" 2>/dev/null || rm -f "$SCRIPT_PATH"
echo "      Done"

echo ""
echo "  ✅ CB Fleet V2 has been fully removed from $(hostname)."
echo "  All services, data, configs, and credentials wiped."
echo ""
