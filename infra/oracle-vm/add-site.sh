#!/usr/bin/env bash
# Adds, replaces or removes one site behind the shared Caddy.
#
#   sudo bash add-site.sh <name> proxy <port>   [--host <hostname>]
#   sudo bash add-site.sh <name> static <dir>   [--host <hostname>]
#   sudo bash add-site.sh <name> remove
#
# proxy  — an app listening on 127.0.0.1:<port> (a Docker app publishing
#          127.0.0.1:<port>:<port>, or a systemd service bound to 127.0.0.1)
# static — files in <dir>, with index.html as the fallback for client-side
#          routes
#
# The hostname defaults to <name>.<root-domain> (/etc/caddy/root-domain).
# The whole config is validated before Caddy reloads; if it doesn't validate,
# the previous file is put back, so a mistake here never takes the other
# sites down.
set -euo pipefail

SITES_DIR="${SITES_DIR:-/etc/caddy/sites}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
ROOT_FILE="${ROOT_FILE:-/etc/caddy/root-domain}"
RELOAD="${RELOAD:-systemctl reload caddy}"

usage() { sed -n '4,6p' "$0" | sed 's/^# *//'; exit 2; }

NAME="${1:-}"; KIND="${2:-}"; TARGET="${3:-}"
[ -n "$NAME" ] && [ -n "$KIND" ] || usage
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "Name must be lowercase letters, digits and dashes: $NAME"; exit 2; }
shift 2; [ "$KIND" = remove ] || [ $# -eq 0 ] || shift
HOST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host needs a hostname}"; shift 2 ;;
    *) usage ;;
  esac
done

FILE="$SITES_DIR/$NAME.caddy"
BACKUP="$(mktemp)"
trap 'rm -f "$BACKUP"' EXIT
had_file=0
[ -f "$FILE" ] && { cp "$FILE" "$BACKUP"; had_file=1; }

case "$KIND" in
  proxy)
    [[ "$TARGET" =~ ^[0-9]+$ ]] || { echo "proxy needs a port number"; exit 2; }
    BODY="	reverse_proxy 127.0.0.1:$TARGET" ;;
  static)
    [[ "$TARGET" = /* ]] && [ -d "$TARGET" ] || { echo "static needs an existing absolute folder: $TARGET"; exit 2; }
    BODY="	root * $TARGET
	try_files {path} {path}/index.html /index.html
	file_server" ;;
  remove)
    [ "$had_file" = 1 ] || { echo "No site named $NAME."; exit 1; }
    rm -f "$FILE" ;;
  *) usage ;;
esac

if [ "$KIND" != remove ]; then
  if [ -z "$HOST" ]; then
    [ -s "$ROOT_FILE" ] || { echo "No $ROOT_FILE — run setup.sh first, or pass --host."; exit 1; }
    HOST="$NAME.$(tr -d '[:space:]' < "$ROOT_FILE")"
  fi
  cat > "$FILE" <<EOF
# $NAME — written by add-site.sh ($KIND $TARGET)
$HOST {
	encode gzip
$BODY
}
EOF
fi

if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
  echo "Caddy rejected the change; putting the previous state back. Details:"
  caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1 | tail -5 || true
  if [ "$had_file" = 1 ]; then cp "$BACKUP" "$FILE"; else rm -f "$FILE"; fi
  exit 1
fi
$RELOAD

if [ "$KIND" = remove ]; then
  echo "Removed $NAME."
else
  echo "https://$HOST -> $KIND $TARGET"
  echo "The first visit fetches its HTTPS certificate, which can take a few seconds."
fi
