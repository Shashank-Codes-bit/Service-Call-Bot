#!/usr/bin/env bash
# One-time setup of a fresh Oracle Cloud Ubuntu 24.04 VM: open the VM's own
# firewall for HTTP and HTTPS, then install Docker. Run as the `ubuntu` user.
# Touches no secrets.
set -euo pipefail

# Oracle's Ubuntu images ship iptables rules that reject everything except SSH,
# on top of the subnet's security list — opening the security list alone is
# not enough. Insert the two ports ahead of the REJECT. Saved before Docker is
# installed, so Docker's own rules are not frozen into the saved set.
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    line=$(sudo iptables -L INPUT --line-numbers | awk '$2 == "REJECT" { print $1; exit }')
    if [ -n "$line" ]; then
      sudo iptables -I INPUT "$line" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    else
      sudo iptables -A INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    fi
  fi
done
if command -v netfilter-persistent >/dev/null; then
  sudo netfilter-persistent save
fi

# Docker Engine and the compose plugin, from Docker's own apt repository.
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"

cat <<'EOF'

Setup done. Log out and back in (so `docker` works without sudo), then:

  cd ~/Service-Call-Bot/svc-agent/deploy/oracle
  nano .env          # CLAUDE_API_KEY, ADMIN_PASSWORD, CALL_API_SECRET, SITE_ADDRESS
  docker compose up -d --build
EOF
