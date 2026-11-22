#!/usr/bin/env bash
# LUMA Live 一键启动（macOS / Linux）
set -u
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-3000}"

echo
echo "  ============================================"
echo "    LUMA Live  直播间"
echo "  ============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  [X] 没有找到 Node.js。"
  echo
  echo "      这个项目需要 Node.js 18 以上版本："
  echo "        macOS   brew install node"
  echo "        Ubuntu  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  echo "      或者直接到 https://nodejs.org 下载"
  echo
  exit 1
fi

MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "${MAJOR:-0}" -lt 18 ]; then
  echo "  [X] Node.js 版本太旧（$(node -v)），需要 18 以上。"
  exit 1
fi

echo "  [OK] Node.js $(node -v)"
echo

# 1 秒后尝试打开浏览器（失败也不影响服务）
(
  sleep 1
  URL="http://localhost:${PORT}/studio"
  if command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  fi
) &

echo "  开播台   http://localhost:${PORT}/studio"
echo "  观众页   http://localhost:${PORT}/"
echo
echo "  按 Ctrl+C 停止。"
echo

exec env PORT="$PORT" node server.js
