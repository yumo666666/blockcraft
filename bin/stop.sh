#!/bin/bash
# 停止面板（不会结束正在运行的世界）。
# 关键：不依赖面板自己的 HTTP 接口 —— 面板卡住/端口被占时正需要停它，
# 所以直接在 /proc 里按 cmdline 找进程。
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
PORT="${BC_PORT:-$(python3 -c "import json;print(json.load(open('data/panel.json'))['panel']['port'])" 2>/dev/null || echo 8081)}"

# 只在 comm 确实是 node 的进程里找，避免匹配到当前这个 shell（踩过：脚本把自己 kill 了）
find_panels() {
  bash "$(dirname "$0")/proc-find.sh" node "server/src/index.ts"
}

PIDS=$(find_panels)
if [ -z "$PIDS" ]; then
  echo "没有在跑的面板进程（$PORT 空闲）"
  exit 0
fi
echo "找到面板进程：$PIDS"
for pid in $PIDS; do kill "$pid" 2>/dev/null && echo "  已发送 TERM → $pid"; done

for i in $(seq 1 15); do
  sleep 1
  PIDS=$(find_panels)
  [ -z "$PIDS" ] && break
  if [ "$i" = "10" ]; then for pid in $PIDS; do kill -9 "$pid" 2>/dev/null && echo "  强制结束 → $pid"; done; fi
done

if [ -n "$(find_panels)" ]; then
  echo "警告：面板仍未退出" >&2
  exit 1
fi
if command -v curl >/dev/null && curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/api/ping"; then
  echo "注意：$PORT 上还有别的服务在响应（可能不是本项目的面板）" >&2
fi
echo "面板已停止"
