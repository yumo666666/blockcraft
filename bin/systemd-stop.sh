#!/usr/bin/env bash
# Invoke the panel's guarded shutdown API using the same Node runtime as startup.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

node_ok() {
  "$1" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 6)) process.exit(1)' >/dev/null 2>&1
}

NODE_BIN=""
if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
elif [[ -x "$ROOT/.runtime/node/bin/node" ]]; then
  NODE_BIN="$ROOT/.runtime/node/bin/node"
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "[BlockCraft] Node.js 22.6+ is unavailable; keeping the service alive rather than force-closing worlds." >&2
  while true; do sleep 60; done
fi

exec "$NODE_BIN" "$ROOT/bin/systemd-stop.mjs"
