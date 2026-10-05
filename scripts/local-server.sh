#!/bin/bash
# 本机常驻网页与接口；由 com.psyhot.local.server 管理，不启动 worker 或外网隧道。
set -eu
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
export NODE_ENV=production AIHOT_ENVIRONMENT=local
export SITE_URL=http://localhost:3000 API_BASE_URL=http://127.0.0.1:3001
export WEB_HOST=127.0.0.1 WEB_PORT=3000 API_HOST=127.0.0.1 API_PORT=3001
export COLLECT_ENABLED=false MODEL_CALLS_ENABLED=false EMAIL_ENABLED=false
export FEISHU_CONTENT_PUSH_ENABLED=false FEISHU_X_PUSH_ENABLED=false INDEXNOW_SUBMIT_ENABLED=false
export ALLOW_PRIVATE_NETWORK_FETCH=false AIHOT_CREDENTIALS_DIR=/nonexistent-local-server-credentials
LOCAL_LOG_DIR="$REPO_ROOT/.data/local-server/logs"
mkdir -p "$LOCAL_LOG_DIR"
children=()
cleanup() {
  for child in "${children[@]}"; do kill -TERM "$child" 2>/dev/null || true; done
  for child in "${children[@]}"; do wait "$child" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 0' TERM INT
node --env-file=.env --input-type=module -e 'for (const key of Object.keys(process.env)) if (key.startsWith("DEV_AUTH_")) delete process.env[key]; await import("./apps/api/src/main.ts");'  >> "$LOCAL_LOG_DIR/api.log" 2>&1 & children+=($!)
node --env-file=.env apps/web/server.ts >> "$LOCAL_LOG_DIR/web.log" 2>&1 & children+=($!)
while true; do
  for child in "${children[@]}"; do
    if ! kill -0 "$child" 2>/dev/null; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') 一个服务已退出，等待本机服务管理器重启。"
      exit 1
    fi
  done
  sleep 2
done
