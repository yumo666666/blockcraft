#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.6 or newer is required to build the Windows package." >&2
  exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 6)) process.exit(1)' || {
  echo "Node.js 22.6 or newer is required to build the Windows package." >&2
  exit 1
}
if ! command -v go >/dev/null 2>&1; then
  echo "Go is required to compile the small Windows launcher." >&2
  exit 1
fi
GO_BIN="$(command -v go)"
if ! "$GO_BIN" version 2>/dev/null | grep -Eq '^go version go[0-9]+\.'; then
  echo "The 'go' command is not the Go compiler. Install Go and try again." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required to build the web UI and prepare server dependencies." >&2
  exit 1
fi

pnpm install --frozen-lockfile || {
  pnpm approve-builds esbuild
  pnpm install --frozen-lockfile
}
pnpm build

OUT="$ROOT/dist-release/BlockCraft-Windows-x64"
ZIP="$ROOT/dist-release/BlockCraft-Windows-x64.zip"
rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT/app/web" "$OUT/app/bin" "$OUT/runtime"
pnpm --filter @blockcraft/server deploy --prod --legacy --config.node-linker=hoisted "$OUT/app/server-runtime"
(cd "$OUT/app/server-runtime" && node --experimental-strip-types --input-type=module -e "await import('./src/index.ts')")
cp -R web/dist "$OUT/app/web/dist"
cp -R bin/. "$OUT/app/bin/"

NODE_VERSION="${BC_WINDOWS_NODE_VERSION:-24.19.0}"
ARCHIVE="node-v${NODE_VERSION}-win-x64.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl --fail --location --silent --show-error "https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}" -o "$TMP/$ARCHIVE"
python3 - "$TMP/$ARCHIVE" "$OUT/runtime/node.exe" <<'PY'
import sys
import zipfile

archive, destination = sys.argv[1:]
with zipfile.ZipFile(archive) as bundle:
    candidate = next(name for name in bundle.namelist() if name.endswith("/node.exe"))
    with bundle.open(candidate) as source, open(destination, "wb") as target:
        target.write(source.read())
PY

(cd packaging/windows && GO111MODULE=on GOOS=windows GOARCH=amd64 "$GO_BIN" build -mod=readonly -trimpath -ldflags='-s -w -H=windowsgui' -o "$OUT/BlockCraft.exe" .)
cat > "$OUT/README.txt" <<'EOF'
BlockCraft Windows x64

Unzip the complete folder and double-click BlockCraft.exe.
The first start opens the local management panel in your default browser.
BlockCraft stays in the Windows notification area. Right-click its icon to
open the panel, restart only the panel while worlds keep running, or stop all
worlds and exit after a confirmation prompt.
Everything BlockCraft creates is kept inside this extracted folder:
  data\       settings, logs, downloads, Java runtimes, backups
  instances\  Minecraft worlds and server files
Extract the whole archive to a writable folder. Do not run it from inside the ZIP
or from a read-only location such as Program Files.

The bundled Node.js runtime starts the panel. If a world needs a Java version
that is not installed, BlockCraft downloads Temurin into data\jdk automatically.
EOF

python3 - "$OUT" "$ZIP" <<'PY'
import os
import sys
import zipfile

folder, destination = sys.argv[1:]
with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
    parent = os.path.dirname(folder)
    for root, _, files in os.walk(folder):
        for filename in files:
            full = os.path.join(root, filename)
            bundle.write(full, os.path.relpath(full, parent))

with zipfile.ZipFile(destination) as bundle:
    names = set(bundle.namelist())
    prefix = "BlockCraft-Windows-x64/app/server-runtime/node_modules/"
    required = [prefix + name + "/package.json" for name in ("express", "yauzl", "yazl")]
    missing = [name for name in required if name not in names]
    if missing:
        raise SystemExit("Windows package is missing runtime dependencies: " + ", ".join(missing))
PY

CI=true pnpm install --frozen-lockfile
echo "Created $ZIP"
