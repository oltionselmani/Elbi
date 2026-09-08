#!/usr/bin/env bash
#
# Put Elbi on your Tailscale network: private, HTTPS, and always on.
#
#   bash scripts/tailscale-setup.sh
#
# Nothing here is exposed to the public internet. Tailscale is a private
# network between your own devices, so there is no address for a stranger to
# find — which is a stronger guarantee than any firewall rule.
#
# Run it on the machine that holds the films. Linux and macOS; Windows users
# want tailscale-setup.ps1 in this folder.

set -euo pipefail

ELBI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# $USER is not always exported (cron, some service managers), and this
# script runs under `set -u`.
WHOAMI="${USER:-$(id -un)}"
PORT="${ELBI_PORT:-8080}"
NAME="${ELBI_TS_NAME:-elbi}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m\n  %s\033[0m\n\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
say "1. Checking Tailscale"

if ! command -v tailscale >/dev/null 2>&1; then
  info "Tailscale is not installed."
  case "$(uname -s)" in
    Linux)
      info "Install it with:  curl -fsSL https://tailscale.com/install.sh | sh"
      ;;
    Darwin)
      info "Install it from the Mac App Store, or:  brew install --cask tailscale"
      ;;
  esac
  die "Install Tailscale, run 'tailscale up', then run this script again."
fi

if ! tailscale status >/dev/null 2>&1; then
  info "Tailscale is installed but not signed in."
  die "Run 'tailscale up' and sign in, then run this script again."
fi

info "Tailscale is running."

# MagicDNS gives the machine a stable name. Without it you get a bare IP,
# which works but is not something you can tell someone over the phone.
if ! tailscale status --json 2>/dev/null | grep -q '"MagicDNSSuffix": *"[^"]'; then
  warn "MagicDNS looks disabled. Turn it on at https://login.tailscale.com/admin/dns"
  warn "so the address is a name rather than an IP address."
fi

# ---------------------------------------------------------------------------
say "2. Checking the sign-in"

if [ ! -f "$ELBI_DIR/data/credentials.json" ]; then
  warn "No sign-in has been set up yet."
  info "Run this first, and choose a password you have not used elsewhere:"
  info "    cd '$ELBI_DIR' && npm run set-login"
  die "Set the login, then run this script again."
fi
info "A sign-in is configured."

# ---------------------------------------------------------------------------
say "3. Writing the service"
#
# Two settings matter and belong together:
#
#   ELBI_HOST=127.0.0.1   Elbi listens only on this machine. Tailscale is then
#                         the single way in — it is not on your home wifi
#                         either, so a guest on your network cannot reach it.
#
#   ELBI_TRUST_PROXY=1    Behind a proxy every request appears to come from
#                         127.0.0.1, so without this the login lockout would be
#                         shared: one person mistyping their password five
#                         times would lock out the whole family. This is only
#                         safe *because* of the line above — nothing can reach
#                         Elbi directly to forge the header.

ENV_LINES=(
  "ELBI_HOST=127.0.0.1"
  "ELBI_PORT=$PORT"
  "ELBI_TRUST_PROXY=1"
)
[ -n "${ELBI_MEDIA_DIR:-}" ] && ENV_LINES+=("ELBI_MEDIA_DIR=$ELBI_MEDIA_DIR")
[ -n "${ELBI_SCAN_DIRS:-}" ] && ENV_LINES+=("ELBI_SCAN_DIRS=$ELBI_SCAN_DIRS")
[ -n "${ELBI_TMDB_KEY:-}" ]  && ENV_LINES+=("ELBI_TMDB_KEY=$ELBI_TMDB_KEY")

NODE_BIN="$(command -v node)" || die "Node.js is not installed."

case "$(uname -s)" in
Linux)
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  {
    echo "[Unit]"
    echo "Description=Elbi"
    echo "After=network-online.target"
    echo
    echo "[Service]"
    echo "Type=simple"
    echo "WorkingDirectory=$ELBI_DIR"
    echo "ExecStart=$NODE_BIN $ELBI_DIR/server.js"
    for line in "${ENV_LINES[@]}"; do echo "Environment=$line"; done
    echo "Restart=always"
    echo "RestartSec=5"
    echo
    echo "[Install]"
    echo "WantedBy=default.target"
  } > "$UNIT_DIR/elbi.service"

  systemctl --user daemon-reload
  systemctl --user enable --now elbi.service
  # Without this the service stops when you log out of the desktop.
  loginctl enable-linger "$WHOAMI" 2>/dev/null || \
    warn "Could not enable lingering; Elbi may stop when you log out. Try: sudo loginctl enable-linger $WHOAMI"
  info "systemd user service installed and started."
  info "Logs:    journalctl --user -u elbi -f"
  info "Restart: systemctl --user restart elbi"
  ;;

Darwin)
  PLIST="$HOME/Library/LaunchAgents/com.elbi.server.plist"
  mkdir -p "$(dirname "$PLIST")"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo '  <key>Label</key><string>com.elbi.server</string>'
    echo '  <key>ProgramArguments</key><array>'
    echo "    <string>$NODE_BIN</string><string>$ELBI_DIR/server.js</string>"
    echo '  </array>'
    echo "  <key>WorkingDirectory</key><string>$ELBI_DIR</string>"
    echo '  <key>EnvironmentVariables</key><dict>'
    for line in "${ENV_LINES[@]}"; do
      echo "    <key>${line%%=*}</key><string>${line#*=}</string>"
    done
    echo '  </dict>'
    echo '  <key>RunAtLoad</key><true/>'
    echo '  <key>KeepAlive</key><true/>'
    echo "  <key>StandardOutPath</key><string>$HOME/Library/Logs/elbi.log</string>"
    echo "  <key>StandardErrorPath</key><string>$HOME/Library/Logs/elbi.log</string>"
    echo '</dict></plist>'
  } > "$PLIST"

  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
  info "launchd agent installed and started."
  info "Logs:    tail -f ~/Library/Logs/elbi.log"
  info "Restart: launchctl kickstart -k gui/\$UID/com.elbi.server"
  ;;

*)
  die "Unsupported system. Use scripts/tailscale-setup.ps1 on Windows."
  ;;
esac

# ---------------------------------------------------------------------------
say "4. Publishing it on your tailnet"

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/auth/status" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/auth/status" >/dev/null 2>&1 \
  || die "Elbi did not come up on port $PORT. Check the logs above."
info "Elbi is answering on 127.0.0.1:$PORT."

# `tailscale serve` terminates HTTPS with a real certificate and forwards to
# Elbi. HTTPS is not optional here: iOS only allows Add to Home Screen and the
# offline-download service worker on a secure origin.
tailscale serve --bg "http://127.0.0.1:$PORT" >/dev/null 2>&1 \
  || tailscale serve --bg 443 / "http://127.0.0.1:$PORT" \
  || die "Could not publish with 'tailscale serve'. Check 'tailscale serve status'."

URL="$(tailscale serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1 || true)"
[ -z "$URL" ] && URL="https://$(tailscale status --json | sed -n 's/.*"DNSName": *"\([^"]*\)\..*/\1/p' | head -1).$(tailscale status --json | sed -n 's/.*"MagicDNSSuffix": *"\([^"]*\)".*/\1/p' | head -1)"

# ---------------------------------------------------------------------------
say "Done"
cat <<EOF

  Your address:   $URL

  It is reachable only from devices signed into your Tailscale account.
  Nothing is published to the public internet.

  For each family member:
    1. Install Tailscale on their phone (App Store / Play Store).
    2. Sign in — or accept the invite you send from
       https://login.tailscale.com/admin/users
    3. Open $URL in Safari or Chrome.
    4. Sign in once with the email and password, leaving
       "Remember this device" ticked. They will not be asked again.
    5. iPhone: Share -> Add to Home Screen. It then opens like an app,
       full screen, with the Elbi icon.

  Useful later:
    tailscale serve status      what is published
    tailscale serve --https=443 off    stop publishing
    npm run set-login           change the email or password
                                (this signs every device out)

EOF
