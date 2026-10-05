#!/bin/bash
# 管理本机常驻网站：start / stop / restart / update / status。
set -eu
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
LOCAL_SERVICE="gui/$(id -u)/com.psyhot.local.server"
LOCAL_PLIST="$HOME/Library/LaunchAgents/com.psyhot.local.server.plist"
case "${1:-status}" in
  start)
    launchctl enable "$LOCAL_SERVICE"
    if ! launchctl print "$LOCAL_SERVICE" >/dev/null 2>&1; then launchctl bootstrap "gui/$(id -u)" "$LOCAL_PLIST"; fi
    echo "网站已启动：http://localhost:3000" ;;
  stop)
    if launchctl print "$LOCAL_SERVICE" >/dev/null 2>&1; then launchctl bootout "$LOCAL_SERVICE"; fi
    echo "本次登录期间的网站已停止；下次登录仍会自动启动。" ;;
  restart) launchctl kickstart -k "$LOCAL_SERVICE"; echo "网站已重启。" ;;
  update)
    npm run build -w @aihot/web
    launchctl kickstart -k "$LOCAL_SERVICE"
    echo "当前文件已构建并更新到 http://localhost:3000" ;;
  status)
    if launchctl print "$LOCAL_SERVICE" >/dev/null 2>&1; then echo "本机服务已加载。"; else echo "本机服务未加载。"; fi
    node --input-type=module -e 'const r=await fetch("http://localhost:3000/api/health"); if (!r.ok) process.exit(1); console.log("网页和接口可访问：http://localhost:3000");' ;;
  *) echo "用法：bash scripts/local-site.sh [start|stop|restart|update|status]"; exit 2 ;;
esac
