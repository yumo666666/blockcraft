#!/bin/bash
# 停止面板（不会结束正在运行的世界）。若面板不响应，逐次重试拿 PID 再杀。
cd "$(dirname "$0")/.." || exit 1
PORT="${BC_PORT:-$(python3 -c "import json;print(json.load(open('data/panel.json'))['panel']['port'])" 2>/dev/null || echo 8081)}"
TOKEN=$(python3 -c "import json;print(json.load(open('data/panel.json'))['panel']['token'])" 2>/dev/null)
for i in $(seq 1 12); do
  PID=$(curl -s -m 2 "http://127.0.0.1:$PORT/api/system" -H "Cookie: bc_session=x" -b /tmp/bc.cookie 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['panel']['pid'])" 2>/dev/null)
  if [ -z "$PID" ]; then
    # 没登录态就再试一次带 token 的登录
    curl -s -m 2 -c /tmp/bc.cookie -X POST "http://127.0.0.1:$PORT/api/login" -H 'Content-Type: application/json' -H 'X-Blockcraft: 1' -d "{\"token\":\"$TOKEN\"}" >/dev/null 2>&1
    PID=$(curl -s -m 2 -b /tmp/bc.cookie "http://127.0.0.1:$PORT/api/system" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['panel']['pid'])" 2>/dev/null)
  fi
  if [ -z "$PID" ]; then
    curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/api/ping" || { echo "面板已停止（$PORT 已释放）"; exit 0; }
    sleep 1
    continue
  fi
  kill "$PID" 2>/dev/null && echo "已向面板发送 TERM（PID $PID）"
  sleep 2
  if ! curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/api/ping"; then
    echo "面板已停止（$PORT 已释放）"
    exit 0
  fi
done
echo "警告：面板仍在运行，可能需要手动处理" >&2
exit 1
