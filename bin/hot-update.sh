#!/usr/bin/env bash
# Update a source checkout and restart only the BlockCraft panel. Minecraft
# Java processes are independent; this script never asks them to stop.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This update command requires a Git checkout." >&2
  exit 1
fi

export PATH="$ROOT/.runtime/node/bin:$PATH"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js is unavailable. Start BlockCraft once with bin/ubuntu.sh to prepare its local runtime." >&2
  exit 1
fi

SYSTEMD_ACTIVE=0
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet blockcraft.service; then
  SYSTEMD_ACTIVE=1
fi

echo "[BlockCraft] 检查任务并仅关闭面板进程……"
"$NODE_BIN" "$ROOT/bin/hot-update.mjs"

restart_panel() {
  if [[ "$SYSTEMD_ACTIVE" == "1" ]]; then
    for _ in $(seq 1 90); do
      if ! systemctl is-active --quiet blockcraft.service; then break; fi
      sleep 1
    done
    if systemctl is-active --quiet blockcraft.service; then
      echo "[BlockCraft] systemd 服务没有在面板退出后结束；为避免调用会停止世界的 ExecStop，未强行重启服务。" >&2
      return 1
    fi
    if [[ "$EUID" -eq 0 ]]; then
      systemctl start blockcraft.service
    elif command -v sudo >/dev/null 2>&1; then
      sudo systemctl start blockcraft.service
    else
      echo "[BlockCraft] 需要 systemd 权限启动面板：sudo systemctl start blockcraft" >&2
      return 1
    fi
  else
    mkdir -p "$ROOT/data/logs"
    nohup bash "$ROOT/bin/ubuntu.sh" --no-browser >> "$ROOT/data/logs/panel.out" 2>&1 </dev/null &
  fi

  local port
  if [[ -n "${BC_PORT:-}" ]]; then
    port="$BC_PORT"
  else
    port="$("$NODE_BIN" -e 'try { const c=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(c.panel?.port ?? 8081)); } catch { process.stdout.write("8081"); }' "$ROOT/data/panel.json")"
  fi
  for _ in $(seq 1 120); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/api/ping" >/dev/null 2>&1; then
      echo "[BlockCraft] 新面板已启动，Minecraft 世界仍在运行。"
      return 0
    fi
    sleep 1
  done
  echo "[BlockCraft] 面板启动超时，请检查 data/logs/panel.out 或 systemd 日志。" >&2
  return 1
}

finish() {
  local status=$?
  trap - EXIT
  if ! restart_panel; then status=1; fi
  exit "$status"
}
trap finish EXIT

echo "[BlockCraft] 获取 origin 跟踪分支的最新提交……"
git pull --ff-only

PNPM=()
if command -v pnpm >/dev/null 2>&1; then
  PNPM=("$(command -v pnpm)")
elif command -v corepack >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
elif command -v npm >/dev/null 2>&1; then
  mkdir -p "$ROOT/.runtime/tools"
  npm install --prefix "$ROOT/.runtime/tools" --no-audit --no-fund pnpm@11
  PNPM=("$NODE_BIN" "$ROOT/.runtime/tools/node_modules/pnpm/bin/pnpm.cjs")
else
  echo "找不到 pnpm、Corepack 或 npm，无法更新依赖。" >&2
  exit 1
fi

"${PNPM[@]}" install --frozen-lockfile
echo "[BlockCraft] 源码和依赖已更新；正在启动面板。"
