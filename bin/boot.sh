#!/bin/bash
# BlockCraft 启动入口（没有 systemd，靠 DSH 的 web profile 插件或 crontab 调它）
#   DSH App 启动 → dsh web → dsh-blockcraft-boot 插件 → 本脚本
# 幂等：重复执行不会重复起进程。
set -u
cd "$(dirname "$0")/.." || exit 1
mkdir -p data/logs

echo "[boot] $(date '+%F %T') 启动 BlockCraft"

# 1) 面板（自己会把两条 FRP 通道拉起来）
bash bin/start.sh || echo "[boot] 面板启动失败，见 data/logs/panel.out"

# 2) 看门狗（每 60 秒巡检：面板掉线、FRP 通道掉线、世界自启与卡住自愈）
WD=$(bash "$(dirname "$0")/proc-find.sh" node "server/src/watchdog.ts" | head -1)
if [ -n "$WD" ]; then
  echo "[boot] 看门狗已经在运行（PID $WD）"
else
  setsid nohup node server/src/watchdog.ts >> data/logs/watchdog.out 2>&1 < /dev/null &
  echo $! > data/logs/watchdog.pid
  echo "[boot] 看门狗已启动（PID $(cat data/logs/watchdog.pid)）"
fi

echo "[boot] 完成"
