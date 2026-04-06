#!/usr/bin/env bash
# =============================================================
# Fleet RAG — VPS Deployment Script
# Run this on the target VPS after cloning the repo.
# Usage: ANTHROPIC_API_KEY=sk-ant-... bash deploy-vps.sh
# =============================================================
set -euo pipefail

KEY="${ANTHROPIC_API_KEY:-}"
if [ -z "$KEY" ]; then
  echo "ERROR: ANTHROPIC_API_KEY is not set. Run with:"
  echo "  ANTHROPIC_API_KEY=sk-ant-... bash deploy-vps.sh"
  exit 1
fi

HOME_DIR="$HOME"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Step 1: Create directories"
for inst in rag sales support manager; do
  label=$([ "$inst" = "rag" ] && echo "cbfleet-rag" || echo "cbfleet-rag-$inst")
  mkdir -p "$HOME_DIR/$label/.openclaw/agents/main/agent"
  mkdir -p "$HOME_DIR/$label/.openclaw/workspace"
  mkdir -p "$HOME_DIR/$label/.openclaw/logs"
done
mkdir -p "$HOME_DIR/cbfleet-rag/.openclaw/workspace/skills/fleet-rag"
mkdir -p "$HOME_DIR/fleet-api-proxy"

echo "==> Step 2: Copy configs"
cp "$PROJECT_DIR/instances/rag/.openclaw/openclaw.json"      "$HOME_DIR/cbfleet-rag/.openclaw/openclaw.json"
cp "$PROJECT_DIR/instances/sales/.openclaw/openclaw.json"    "$HOME_DIR/cbfleet-rag-sales/.openclaw/openclaw.json"
cp "$PROJECT_DIR/instances/support/.openclaw/openclaw.json"  "$HOME_DIR/cbfleet-rag-support/.openclaw/openclaw.json"
cp "$PROJECT_DIR/instances/manager/.openclaw/openclaw.json"  "$HOME_DIR/cbfleet-rag-manager/.openclaw/openclaw.json"

for inst in rag sales support manager; do
  label=$([ "$inst" = "rag" ] && echo "cbfleet-rag" || echo "cbfleet-rag-$inst")
  cp "$PROJECT_DIR/instances/$inst/.openclaw/exec-approvals.json" "$HOME_DIR/$label/.openclaw/exec-approvals.json"
  cp "$PROJECT_DIR/instances/$inst/.openclaw/workspace/SOUL.md"   "$HOME_DIR/$label/.openclaw/workspace/SOUL.md"
done

echo "==> Step 3: Copy fleet-rag skill"
cp "$PROJECT_DIR/instances/rag/.openclaw/workspace/skills/fleet-rag/SKILL.md" \
   "$HOME_DIR/cbfleet-rag/.openclaw/workspace/skills/fleet-rag/SKILL.md"

echo "==> Step 4: Write API keys"
for dir in "$HOME_DIR/cbfleet-rag" "$HOME_DIR/cbfleet-rag-sales" "$HOME_DIR/cbfleet-rag-support" "$HOME_DIR/cbfleet-rag-manager"; do
  cat > "$dir/.openclaw/agents/main/agent/auth-profiles.json" <<EOF
{
  "version": 1,
  "profiles": {
    "anthropic:default": { "type": "token", "provider": "anthropic", "token": "$KEY" }
  },
  "lastGood": { "anthropic": "anthropic:default" }
}
EOF
done

echo "==> Step 5: Install & start API proxy"
cp "$PROJECT_DIR/proxy/server.js"      "$HOME_DIR/fleet-api-proxy/server.js"
cp "$PROJECT_DIR/proxy/package.json"   "$HOME_DIR/fleet-api-proxy/package.json"
cd "$HOME_DIR/fleet-api-proxy"
npm install --silent
if command -v pm2 &>/dev/null; then
  pm2 start server.js --name fleet-api-proxy || pm2 restart fleet-api-proxy
else
  echo "WARNING: pm2 not found. Start proxy manually: node $HOME_DIR/fleet-api-proxy/server.js &"
fi

echo "==> Step 6: Start OpenClaw gateways (PM2)"
if command -v pm2 &>/dev/null; then
  for inst in rag sales support manager; do
    label=$([ "$inst" = "rag" ] && echo "cbfleet-rag" || echo "cbfleet-rag-$inst")
    port=1950$([ "$inst" = "rag" ] && echo "0" || { [ "$inst" = "sales" ] && echo "1" || { [ "$inst" = "support" ] && echo "2" || echo "3"; }; })
    OPENCLAW_HOME="$HOME_DIR/$label" pm2 start openclaw \
      --name "fleet-$inst" -- gateway run --port $port --force 2>/dev/null || \
    OPENCLAW_HOME="$HOME_DIR/$label" pm2 restart "fleet-$inst"
  done
  pm2 save
  echo "==> PM2 processes saved."
else
  echo "WARNING: pm2 not found. Start gateways manually."
fi

echo ""
echo "==> Step 7: Health check"
sleep 3
for port in 19500 19501 19502 19503; do
  status=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port/health" 2>/dev/null || echo "ERR")
  echo "  Port $port: $status"
done

echo ""
echo "==> Proxy test (list handoffs for Support):"
curl -s -X POST http://127.0.0.1:20000/fleet-api/handoff \
  -H "Content-Type: application/json" \
  -d '{"action":"list","agent_id":"325e5143-3c0b-4d65-b548-a34cbdba5949"}'

echo ""
echo "==> Deploy complete!"
