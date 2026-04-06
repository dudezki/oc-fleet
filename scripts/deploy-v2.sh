#!/bin/bash
# ============================================================
#  CB Fleet V2 — VM Deployment Script
#  Run on the target VM as root (or with sudo)
#  Usage: sudo bash deploy-v2.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_USER="${SUDO_USER:-$(whoami)}"
FLEET_HOME="/home/$FLEET_USER"

echo "================================================"
echo "  CB Fleet V2 — Deployment"
echo "  User: $FLEET_USER | Host: $(hostname)"
echo "  Time: $(date)"
echo "================================================"
echo ""

# ── 1. System deps ──────────────────────────────────────────
echo "[1/6] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl git nginx docker.io docker-compose-plugin jq unzip
systemctl enable docker
systemctl start docker
echo "      Done"

# ── 2. Node.js (via nvm for user) ───────────────────────────
echo "[2/6] Setting up Node.js..."
if ! command -v node &>/dev/null; then
  sudo -u "$FLEET_USER" bash -c '
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    source "$NVM_DIR/nvm.sh"
    nvm install 20
    nvm use 20
    nvm alias default 20
  '
fi
echo "      Done"

# ── 3. Install OpenClaw ──────────────────────────────────────
echo "[3/6] Installing OpenClaw..."
sudo -u "$FLEET_USER" bash -c '
  export NVM_DIR="$HOME/.nvm"
  source "$NVM_DIR/nvm.sh"
  npm install -g openclaw
'
echo "      Done"

# ── 4. Deploy fleet application ─────────────────────────────
echo "[4/6] Deploying fleet application..."
# This is where you'd rsync/git clone your fleet files
# Placeholder — fill in your actual deploy steps:
# rsync -avz ./cbfleet/ "$FLEET_HOME/cbfleet/"
# cd "$FLEET_HOME/cbfleet" && npm install --production
echo "      (Placeholder — add your deploy steps here)"

# ── 5. Install self-destruct ─────────────────────────────────
echo "[5/6] Installing self-destruct..."
DESTRUCT_PATH="/usr/local/sbin/fleet-destruct"
if [ -f "$SCRIPT_DIR/fleet-destruct.sh" ]; then
  cp "$SCRIPT_DIR/fleet-destruct.sh" "$DESTRUCT_PATH"
  chmod 700 "$DESTRUCT_PATH"
  chown root:root "$DESTRUCT_PATH"
  echo "      Installed at $DESTRUCT_PATH (root-only)"
else
  echo "      WARNING: fleet-destruct.sh not found, skipping"
fi

# ── 6. Summary ──────────────────────────────────────────────
echo ""
echo "[6/6] Deployment complete."
echo ""
echo "  Node: $(node -v 2>/dev/null || echo 'check manually')"
echo "  OpenClaw: $(openclaw --version 2>/dev/null || echo 'check manually')"
echo "  Destruct: $([ -f $DESTRUCT_PATH ] && echo '✅ installed' || echo '❌ missing')"
echo ""
echo "  Kill switch: sudo fleet-destruct <YOUR-6-DIGIT-CODE>"
echo "================================================"
