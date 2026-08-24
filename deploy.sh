#!/bin/bash
# Sam's Social System - deploy + restart
# Usage: bash ~/api.sams-social-system.sams.ge/deploy.sh
set -e

APP_DIR="$HOME/api.sams-social-system.sams.ge"
NODE_BIN="/opt/alt/alt-nodejs22/root/usr/bin/node"

cd "$APP_DIR"

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Installing dependencies"
/opt/alt/alt-nodejs22/root/usr/bin/npm install --omit=dev --no-audit --no-fund

echo "==> Stopping old process"
if [ -f app.pid ] && kill -0 "$(cat app.pid)" 2>/dev/null; then
  kill "$(cat app.pid)"
  sleep 1
fi
# belt and braces: kill anything still bound to our app
pgrep -f "$NODE_BIN app.js" | while read -r pid; do kill "$pid" 2>/dev/null || true; done
sleep 1

echo "==> Starting app"
nohup "$NODE_BIN" app.js > app.log 2>&1 &
echo $! > app.pid
sleep 3

echo "==> Health check"
curl -s http://localhost:3000/health
echo ""
echo "==> Done. Log: $APP_DIR/app.log"
