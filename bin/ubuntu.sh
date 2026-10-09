#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/.runtime"
LOCAL_NODE="$RUNTIME/node"
NODE_VERSION="${BC_UBUNTU_NODE_VERSION:-24.19.0}"

node_ok() {
  "$1" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 6)) process.exit(1)' >/dev/null 2>&1
}

NODE_BIN=""
if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
else
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  mkdir -p "$RUNTIME"
  ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  URL="https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error "$URL" -o "$RUNTIME/$ARCHIVE"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$URL" -O "$RUNTIME/$ARCHIVE"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,urllib.request; urllib.request.urlretrieve(sys.argv[1],sys.argv[2])' "$URL" "$RUNTIME/$ARCHIVE"
  else
    echo "Install curl, wget, or Python 3 to download the portable Node.js runtime." >&2
    exit 1
  fi
  rm -rf "$LOCAL_NODE"
  mkdir -p "$LOCAL_NODE"
  tar -xJf "$RUNTIME/$ARCHIVE" -C "$LOCAL_NODE" --strip-components=1
  rm -f "$RUNTIME/$ARCHIVE"
  NODE_BIN="$LOCAL_NODE/bin/node"
  export PATH="$LOCAL_NODE/bin:$PATH"
fi

export BC_ROOT="${BC_ROOT:-$ROOT}"
export BC_DATA_DIR="${BC_DATA_DIR:-$ROOT/data}"
export BC_INSTANCE_DIR="${BC_INSTANCE_DIR:-$ROOT/instances}"
NODE_PROXY_ARGS=()
if "$NODE_BIN" --help 2>&1 | grep -q -- '--use-env-proxy'; then
  NODE_PROXY_ARGS+=(--use-env-proxy)
fi

if command -v pnpm >/dev/null 2>&1; then
  PNPM=("$(command -v pnpm)")
elif command -v corepack >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
else
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is missing. Install Node.js 22.6 or newer and run this script again." >&2
    exit 1
  fi
  mkdir -p "$RUNTIME/tools"
  npm install --prefix "$RUNTIME/tools" --no-audit --no-fund pnpm@11
  PNPM=("$NODE_BIN" "$RUNTIME/tools/node_modules/pnpm/bin/pnpm.cjs")
fi

if [ ! -d "$ROOT/node_modules" ] || [ ! -f "$ROOT/web/dist/index.html" ]; then
  cd "$ROOT"
  "${PNPM[@]}" install --frozen-lockfile || {
    "${PNPM[@]}" approve-builds esbuild
    "${PNPM[@]}" install --frozen-lockfile
  }
  "${PNPM[@]}" build
fi

cd "$ROOT"
"$NODE_BIN" "${NODE_PROXY_ARGS[@]}" --experimental-strip-types "$ROOT/server/src/index.ts" &
PANEL_PID=$!
stop_panel() {
  if kill -0 "$PANEL_PID" 2>/dev/null; then
    kill -TERM "$PANEL_PID" 2>/dev/null || true
    wait "$PANEL_PID" 2>/dev/null || true
  fi
}
trap stop_panel EXIT INT TERM

if [ -n "${BC_PORT:-}" ]; then
  PORT="$BC_PORT"
else
  PORT="$("$NODE_BIN" -e 'try { const cfg=require(process.argv[1]); process.stdout.write(String(cfg.panel?.port ?? 8081)); } catch { process.stdout.write("8081"); }' "$BC_DATA_DIR/panel.json")"
fi
export PANEL_PORT="$PORT"
if ! "$NODE_BIN" -e 'const until=Date.now()+90000; (async()=>{ while(Date.now()<until){ try{const r=await fetch(`http://127.0.0.1:${process.env.PANEL_PORT}/api/ping`); if(r.ok) process.exit(0);}catch{} await new Promise(r=>setTimeout(r,500)); } process.exit(1); })()'; then
  echo "BlockCraft did not start. Check the panel log under $BC_DATA_DIR/logs/ and confirm the port is available." >&2
  exit 1
fi

TOKEN="$($NODE_BIN -e 'try { const cfg=require(process.argv[1]); process.stdout.write(cfg.panel?.token ?? ""); } catch {}' "$BC_DATA_DIR/panel.json")"
PANEL_URL="http://127.0.0.1:${PORT}/"
if [ -n "$TOKEN" ]; then PANEL_URL="${PANEL_URL}?token=${TOKEN}"; fi
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$PANEL_URL" >/dev/null 2>&1 &
  echo "BlockCraft is ready. Your browser is opening the local panel."
else
  echo "BlockCraft is ready at http://127.0.0.1:${PORT}/"
  echo "The login token is stored in $BC_DATA_DIR/panel.json."
fi

wait "$PANEL_PID"
