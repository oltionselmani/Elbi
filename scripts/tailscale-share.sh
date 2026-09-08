#!/usr/bin/env bash
#
# Give someone outside your household access to Elbi — a friend in another
# country, say.
#
#   bash scripts/tailscale-share.sh
#
# Distance is irrelevant here. Tailscale is not a home-network thing: it builds
# an encrypted link between two machines wherever they are, so a friend 2,000km
# away connects exactly as if they were in the next room. What actually limits
# them is your home broadband's UPLOAD speed, which this script measures.

set -euo pipefail

PORT="${ELBI_PORT:-8080}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m\n  %s\033[0m\n\n' "$*" >&2; exit 1; }

command -v tailscale >/dev/null 2>&1 || die "Tailscale is not installed. Run scripts/tailscale-setup.sh first."
tailscale status >/dev/null 2>&1 || die "Tailscale is not signed in. Run 'tailscale up' first."

MACHINE="$(tailscale status --json | sed -n 's/.*"DNSName": *"\([^".]*\)\..*/\1/p' | head -1)"
URL="$(tailscale serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1 || true)"
[ -z "$URL" ] && warn "Elbi does not look published yet — run scripts/tailscale-setup.sh."

# ---------------------------------------------------------------------------
say "Sharing just this one machine"

cat <<EOF
  Share the machine rather than inviting your friend into your whole network.
  A shared machine gives them access to this computer and nothing else — not
  your phone, not your laptop.

    1. Open  https://login.tailscale.com/admin/machines
    2. Find  ${MACHINE:-this computer}
    3. Use the "..." menu on the right -> Share...
    4. Copy the share link and send it to your friend.

  Your friend then:
    1. Installs Tailscale (App Store / Play Store / tailscale.com/download)
       and signs in with their own account — they do not need yours.
    2. Opens your share link and accepts.
    3. Opens ${URL:-your Elbi address} in Safari or Chrome.
    4. Signs in with the email and password you gave them, leaving
       "Remember this device" ticked.
    5. iPhone: Share -> Add to Home Screen.

  To take access away again, revoke the share on the same admin page.
EOF

# ---------------------------------------------------------------------------
say "What will actually limit them"

info "Films are sent from this machine, so your broadband's UPLOAD speed sets"
info "the ceiling — not distance, and not their download speed."
echo

UP=""
if command -v speedtest-cli >/dev/null 2>&1; then
  info "Measuring upload with speedtest-cli…"
  UP="$(speedtest-cli --no-download --simple 2>/dev/null | awk '/Upload/ {print $2}')"
elif command -v speedtest >/dev/null 2>&1; then
  info "Measuring upload with speedtest…"
  UP="$(speedtest --format=json 2>/dev/null | sed -n 's/.*"bandwidth":\([0-9]*\).*/\1/p' | head -1)"
  [ -n "$UP" ] && UP="$(awk -v b="$UP" 'BEGIN{printf "%.1f", b*8/1000000}')"
fi

if [ -n "$UP" ]; then
  info "Your upload: ${UP} Mbit/s"
  awk -v up="$UP" 'BEGIN {
    if (up >= 25)      print "  That is comfortable for 1080p, even for two people at once.";
    else if (up >= 8)  print "  Fine for 1080p for one person. Add a 720p copy if two watch at once.";
    else if (up >= 3)  print "  Enough for 480p-720p. Elbi will offer a smaller copy when it struggles.";
    else               print "  Tight for live streaming. Tell your friend to use Download it first."
  }'
else
  info "Install speedtest-cli to measure it, or check your broadband plan's"
  info "upload figure. Rough guide, per person watching at the same time:"
  info "    480p  ~1-2 Mbit/s      720p  ~3-5 Mbit/s      1080p  ~5-10 Mbit/s"
fi

cat <<'EOF'

  If the link is too thin for live playback, Elbi handles it two ways:

    - It notices repeated stalling and offers a smaller copy of the film,
      or offers to download it first.
    - The download button on any title saves the film to their phone. It
      then plays perfectly, even on aeroplane mode. A slow link that cannot
      stream a film in real time can still fetch it in the background.

  To give the smaller-copy option something to switch to, keep a 480p or
  720p version alongside the big one. Elbi lists every file a title has.

EOF
