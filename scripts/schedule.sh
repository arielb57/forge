#!/usr/bin/env bash
#
# Install, remove or inspect the daily forge run as a launchd agent.
#
# The scheduled job runs `forge run`, which stops at the review queue. It never
# publishes: shipping a project to GitHub stays a command you type yourself.
#
#   ./scripts/schedule.sh install [HH:MM]   default 09:00
#   ./scripts/schedule.sh uninstall
#   ./scripts/schedule.sh status

set -euo pipefail

LABEL="com.arielb57.forge"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$ROOT/data"

usage() { sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1; }

install_agent() {
  local when="${1:-09:00}"
  if [[ ! "$when" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
    echo "error: time must be HH:MM in 24-hour form (got '$when')" >&2
    exit 1
  fi
  local hour="${when%%:*}" minute="${when##*:}"

  local node_bin
  node_bin="$(command -v node)" || { echo "error: node is not on PATH" >&2; exit 1; }

  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"

  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$ROOT/bin/forge.js</string>
    <string>run</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$ROOT</string>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$((10#$hour))</integer>
    <key>Minute</key><integer>$((10#$minute))</integer>
  </dict>

  <!-- The Mac is usually asleep at 09:00; without this the run is skipped
       entirely rather than deferred to the next wake. -->
  <key>RunAtLoad</key>
  <false/>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/schedule.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/schedule.err.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NO_COLOR</key>
    <string>1</string>
  </dict>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF

  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"

  echo "installed: $LABEL runs daily at $when"
  echo "logs:      $LOG_DIR/schedule.out.log"
  echo
  echo "It builds into the review queue and stops. Publish with: forge ship <name>"
}

uninstall_agent() {
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed: $LABEL"
}

status_agent() {
  if launchctl list | grep -q "$LABEL"; then
    echo "loaded:"
    launchctl list | grep "$LABEL"
    echo
    [[ -f "$LOG_DIR/schedule.out.log" ]] && tail -20 "$LOG_DIR/schedule.out.log"
  else
    echo "not loaded"
  fi
}

case "${1:-}" in
  install)   install_agent "${2:-09:00}" ;;
  uninstall) uninstall_agent ;;
  status)    status_agent ;;
  *)         usage ;;
esac
