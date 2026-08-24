#!/bin/bash
# Restarts the API if it is not responding. Safe to run from cron every 5 minutes.
APP_DIR="$HOME/api.sams-social-system.sams.ge"
NODE_BIN="/opt/alt/alt-nodejs22/root/usr/bin/node"

curl -sf --max-time 5 http://localhost:3000/health > /dev/null && exit 0

cd "$APP_DIR" || exit 1
pgrep -f "$NODE_BIN app.js" | while read -r pid; do kill "$pid" 2>/dev/null || true; done
sleep 1
nohup "$NODE_BIN" app.js >> app.log 2>&1 &
echo $! > app.pid
echo "$(date -Is) restarted api" >> keepalive.log
