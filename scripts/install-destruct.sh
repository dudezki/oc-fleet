#!/bin/bash
# ============================================================
#  CB Fleet V2 — Self-Destruct Installer
#  Run once during deployment: sudo bash install-destruct.sh [domain]
#  Example: sudo bash install-destruct.sh fleet.callboxinc.com
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN="${1:-}"

# Install binaries
cp "$SCRIPT_DIR/fleet-destruct.sh"         /usr/local/sbin/fleet-destruct
cp "$SCRIPT_DIR/fleet-destruct-exec.sh"    /usr/local/sbin/fleet-destruct-exec
cp "$SCRIPT_DIR/destruct-webhook.js"       /usr/local/sbin/fleet-destruct-webhook.js
chmod 700 /usr/local/sbin/fleet-destruct
chmod 700 /usr/local/sbin/fleet-destruct-exec
chmod 600 /usr/local/sbin/fleet-destruct-webhook.js
chown root:root /usr/local/sbin/fleet-destruct*

# Install + start webhook service
cp "$SCRIPT_DIR/fleet-destruct-webhook.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable fleet-destruct-webhook
systemctl restart fleet-destruct-webhook
sleep 1
systemctl is-active fleet-destruct-webhook && echo "✅ Webhook service running on 127.0.0.1:9999" || echo "❌ Service failed — check: journalctl -u fleet-destruct-webhook"

# Add nginx route under /fleet-destruct (hidden path)
if [ -n "$DOMAIN" ]; then
  NGINX_CONF="/etc/nginx/sites-available/cbfleet"
  if [ -f "$NGINX_CONF" ]; then
    # Inject destruct location block into existing nginx config
    if ! grep -q "fleet-destruct" "$NGINX_CONF"; then
      sed -i '/server_name/a \
\    # Kill switch (internal proxy — do not expose path publicly)\
    location /_fs {\
        proxy_pass http://127.0.0.1:9999/destruct;\
        proxy_set_header Content-Type application/json;\
        allow all;\
    }' "$NGINX_CONF"
      nginx -t && systemctl reload nginx
      echo "✅ Nginx route /_fs → webhook added"
    fi
  else
    echo "⚠️  No nginx config found at $NGINX_CONF — add proxy manually:"
    echo "   location /_fs { proxy_pass http://127.0.0.1:9999/destruct; }"
  fi
fi

echo ""
echo "================================================"
echo "  Kill switch ready."
echo ""
if [ -n "$DOMAIN" ]; then
echo "  Trigger via HTTP:"
echo "  curl -X POST https://$DOMAIN/_fs \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"code\":\"YOUR-6-DIGIT-CODE\"}'"
else
echo "  Trigger via HTTP (add domain when known):"
echo "  curl -X POST https://YOUR-DOMAIN/_fs \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"code\":\"YOUR-6-DIGIT-CODE\"}'"
fi
echo ""
echo "  Wrong code → silent 404. Right code → system wiped."
echo "================================================"
