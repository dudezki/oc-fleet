#!/usr/bin/env bash
# =============================================================================
# oc-fleet — Data Migration Script
# Transfers the full fleet_dev database from local Mac to Proxmox VM
#
# Usage:
#   bash scripts/migrate-data.sh <VM_USER> <VM_IP>
#
# Example:
#   bash scripts/migrate-data.sh root 192.168.100.50
#
# Prerequisites:
#   - Local: Docker running with cbfleet-rag-db container
#   - Remote: deploy-proxmox.sh already run (PostgreSQL + schema in place)
#   - SSH access to the VM
# =============================================================================

set -euo pipefail

VM_USER="${1:-}"
VM_IP="${2:-}"

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

[ -n "$VM_USER" ] && [ -n "$VM_IP" ] || die "Usage: bash migrate-data.sh <VM_USER> <VM_IP>"

DUMP_FILE="$(dirname "$0")/../fleet_dump.sql"
PG_PORT=5433
PG_USER="${PG_USER:-postgres}"
PG_PASS="${PG_PASSWORD:-fleetdev}"
PG_DB="${PG_DATABASE:-fleet_dev}"

# ── Step 1: Dump local DB ────────────────────────────────────────────────────
info "Dumping local fleet_dev from Docker..."
docker exec cbfleet-rag-db pg_dump -U "$PG_USER" "$PG_DB" > "$DUMP_FILE"
success "Dump saved: $DUMP_FILE ($(wc -l < "$DUMP_FILE") lines)"

# ── Step 2: Copy dump to VM ──────────────────────────────────────────────────
info "Copying dump to $VM_USER@$VM_IP..."
scp "$DUMP_FILE" "$VM_USER@$VM_IP:/tmp/fleet_dump.sql"
success "Dump uploaded to VM"

# ── Step 3: Restore on VM ────────────────────────────────────────────────────
info "Restoring database on VM..."
ssh "$VM_USER@$VM_IP" "
  PGPASSWORD='$PG_PASS' psql -h 127.0.0.1 -p $PG_PORT -U $PG_USER -d $PG_DB \
    -c 'DROP SCHEMA IF EXISTS fleet CASCADE; CREATE SCHEMA fleet;' 2>/dev/null || true
  PGPASSWORD='$PG_PASS' psql -h 127.0.0.1 -p $PG_PORT -U $PG_USER -d $PG_DB < /tmp/fleet_dump.sql
  rm /tmp/fleet_dump.sql
  echo 'Restore complete'
"
success "Database restored on VM"

# ── Step 4: Verify ───────────────────────────────────────────────────────────
info "Verifying row counts on VM..."
ssh "$VM_USER@$VM_IP" "
  PGPASSWORD='$PG_PASS' psql -h 127.0.0.1 -p $PG_PORT -U $PG_USER -d $PG_DB -c \"
    SELECT
      (SELECT COUNT(*) FROM fleet.organizations)    AS orgs,
      (SELECT COUNT(*) FROM fleet.agents)           AS agents,
      (SELECT COUNT(*) FROM fleet.accounts)         AS accounts,
      (SELECT COUNT(*) FROM fleet.memories)         AS memories,
      (SELECT COUNT(*) FROM fleet.conversations)    AS conversations,
      (SELECT COUNT(*) FROM fleet.skills)           AS skills;
  \"
"

echo ""
success "Migration complete! 🚀"
echo ""
echo "  VM: $VM_USER@$VM_IP"
echo "  DB: postgresql://localhost:$PG_PORT/$PG_DB"
