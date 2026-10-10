#!/usr/bin/env bash
# Install or remove a system-level systemd unit for a BlockCraft checkout.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
UNIT_FILE=/etc/systemd/system/blockcraft.service
ACTION="${1:-install}"

if [[ "$ACTION" != install && "$ACTION" != uninstall ]]; then
  echo "Usage: $0 [install|uninstall]" >&2
  exit 2
fi
if [[ "$(uname -s)" != Linux ]] || ! command -v systemctl >/dev/null 2>&1; then
  echo "This script requires Linux with systemd." >&2
  exit 1
fi
if [[ "$EUID" -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Run this command as root (sudo is not installed)." >&2
    exit 1
  fi
  exec sudo bash "$0" "$ACTION"
fi

SERVICE_USER="${SUDO_USER:-${BC_SERVICE_USER:-}}"
if [[ -z "$SERVICE_USER" ]] || ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Could not determine the normal Linux account for BlockCraft." >&2
  echo "Run this from that account with: sudo bash bin/install-systemd.sh" >&2
  exit 1
fi

escape_unit_word() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

if [[ "$ACTION" == uninstall ]]; then
  systemctl disable --now blockcraft.service >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload
  systemctl reset-failed blockcraft.service >/dev/null 2>&1 || true
  echo "Removed $UNIT_FILE. BlockCraft data and worlds were left in place."
  exit 0
fi

ROOT_Q="$(escape_unit_word "$ROOT")"
RUNNER_Q="$(escape_unit_word "$ROOT/bin/ubuntu.sh")"
STOPPER_Q="$(escape_unit_word "$ROOT/bin/systemd-stop.sh")"
DATA_Q="$(escape_unit_word "BC_DATA_DIR=$ROOT/data")"
INSTANCES_Q="$(escape_unit_word "BC_INSTANCE_DIR=$ROOT/instances")"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=BlockCraft Minecraft server management panel
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$ROOT_Q
Environment=$(escape_unit_word "BC_ROOT=$ROOT")
Environment=$DATA_Q
Environment=$INSTANCES_Q
ExecStart=/usr/bin/env bash $RUNNER_Q --no-browser --watchdog
ExecStop=/usr/bin/env bash $STOPPER_Q
Restart=on-failure
RestartSec=10
TimeoutStartSec=0
TimeoutStopSec=0
# ExecStop uses the panel's guarded shutdown path and waits until worlds, FRP and panel stop.
KillMode=process
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$UNIT_FILE"
systemctl daemon-reload
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$UNIT_FILE"
fi
systemctl enable --now blockcraft.service
echo "Installed and started BlockCraft for Linux account $SERVICE_USER."
echo "Check status: systemctl status blockcraft"
echo "Follow logs:  journalctl -u blockcraft -f"
