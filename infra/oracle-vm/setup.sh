#!/usr/bin/env bash
# Setup of the shared Oracle Cloud VM that hosts several sites: the VM's own
# firewall, Docker, and Caddy as the single HTTPS front door. Safe to run
# again — every step checks before it changes anything. Touches no secrets.
#
#   sudo bash infra/oracle-vm/setup.sh [root-domain]
#
# root-domain defaults to <public-ip-with-dashes>.sslip.io, a free hostname
# that resolves to this VM. Sites are then added one by one with add-site.sh.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

ROOT_DOMAIN="${1:-}"
if [ -z "$ROOT_DOMAIN" ]; then
  PUBLIC_IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
  ROOT_DOMAIN="${PUBLIC_IP//./-}.sslip.io"
fi
echo "==> Root domain: $ROOT_DOMAIN"

# Oracle's Ubuntu images reject everything except SSH in iptables, on top of
# the subnet's security list. Open 80 and 443 ahead of the REJECT, and save
# only when a rule was added: saving after Docker is installed would freeze
# Docker's own rules into the restored set.
echo "==> Firewall (80, 443)"
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
changed=0
for port in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    line="$(iptables -L INPUT --line-numbers | awk '$2 == "REJECT" { print $1; exit }')"
    if [ -n "$line" ]; then
      iptables -I INPUT "$line" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    else
      iptables -A INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    fi
    changed=1
  fi
done
if [ "$changed" = 1 ]; then
  command -v netfilter-persistent >/dev/null || apt-get install -y -q iptables-persistent
  netfilter-persistent save >/dev/null
fi

echo "==> Docker"
if ! command -v docker >/dev/null; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl git
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
LOGIN_USER="${SUDO_USER:-ubuntu}"
if id -u "$LOGIN_USER" >/dev/null 2>&1; then usermod -aG docker "$LOGIN_USER"; fi

echo "==> Caddy (the one HTTPS front door, on 80 and 443)"
command -v caddy >/dev/null || { apt-get update -q; apt-get install -y -q caddy; }
install -d -m 755 /etc/caddy/sites /var/www
echo "$ROOT_DOMAIN" > /etc/caddy/root-domain

MAIN=/etc/caddy/Caddyfile
IMPORT="import /etc/caddy/sites/*.caddy"
if ! grep -qxF "$IMPORT" "$MAIN" 2>/dev/null; then
  # Whatever was there (the package's sample, or a single site from an
  # earlier setup) is kept beside it rather than lost.
  [ -f "$MAIN" ] && cp "$MAIN" "$MAIN.before-sites"
  cat > "$MAIN" <<EOF
# Managed by infra/oracle-vm/setup.sh. Sites don't go here: each one is a
# file in /etc/caddy/sites/, written by add-site.sh.
$IMPORT
EOF
  [ -f "$MAIN.before-sites" ] && echo "    previous Caddyfile kept as $MAIN.before-sites"
fi
caddy validate --config "$MAIN" --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

cat <<EOF

==> Done. Sites on this VM:
$(ls /etc/caddy/sites/ 2>/dev/null | sed 's/\.caddy$//; s/^/    /' || true)

Add one with:
  sudo bash $(dirname "$(readlink -f "$0")")/add-site.sh <name> proxy <port>
  sudo bash $(dirname "$(readlink -f "$0")")/add-site.sh <name> static /var/www/<name>
It will be at https://<name>.$ROOT_DOMAIN
EOF
