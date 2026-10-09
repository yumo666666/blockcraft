#!/bin/bash
# 启动 BlockCraft 面板（幂等）。没有 systemd，所以用 setsid 把自己从当前会话里摘出去。
cd "$(dirname "$0")/.." || exit 1
PORT="${BC_PORT:-$(python3 -c "import json;print(json.load(open('data/panel.json'))['panel']['port'])" 2>/dev/null || echo 8081)}"
if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/ping"; then
  echo "面板已经在运行（$PORT）"
  exit 0
fi
mkdir -p data/logs
PORT="$PORT" setsid nohup node --experimental-strip-types server/src/index.ts >> data/logs/panel.out 2>&1 < /dev/null &
for i in $(seq 1 20); do
  sleep 1
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/ping"; then
    echo "面板已启动：http://127.0.0.1:$PORT"
    exit 0
  fi
done
echo "启动失败，请看 data/logs/panel.out" >&2
tail -20 data/logs/panel.out >&2
exit 1
