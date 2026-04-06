#!/usr/bin/env bash
export PATH="/usr/bin:$PATH"
export DATABASE_URL="postgresql://postgres:fleetdev@127.0.0.1:5433/fleet_dev"
export ORG_ID="f86d92cb-db10-43ff-9ff2-d69c319d272d"
exec node /home/dev-user/Projects/oc-fleet/scripts/handoff-worker.js
