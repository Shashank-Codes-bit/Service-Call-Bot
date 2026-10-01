# The shared Oracle Cloud VM: many sites, one machine

One Always Free VM hosts several websites. One **Caddy**, installed on the machine itself, owns ports 80 and 443. It gets and renews a free HTTPS certificate for every site, and sends each visitor to the right app by the hostname they typed. **Each site is one small file**, added with `add-site.sh`.

This file is also meant to be pasted, whole, into another project's chat as the context for deploying that project here.

## The machine
| | |
|---|---|
| Provider | Oracle Cloud, **Always Free** (home region India West, Mumbai, `ap-mumbai-1`) |
| VM | `svc-agent`: `VM.Standard.A1.Flex`, **1 OCPU / 6 GB**, **Arm64**, Ubuntu 24.04 |
| Public IP | `140.238.251.141` |
| Root domain | `140-238-251-141.sslip.io`. Any `<name>.140-238-251-141.sslip.io` also resolves to the VM, with no DNS setup. |
| Network | VCN `svc-agent-vcn`, public subnet `10.0.0.0/24`, internet gateway |
| Open ports | 22, 80, 443: in the subnet's security list **and** the VM's own iptables. Nothing else is needed: every site goes through 443. |
| Login | `ssh -i "$env:USERPROFILE\.ssh\oracle-svc-agent.key" ubuntu@140.238.251.141` (PowerShell). **Disconnect the Voltas VPN first**: it routes Oracle addresses and the SSH connection times out. |
| Installed | Docker + Compose plugin, Caddy 2 (systemd), iptables-persistent |

## How it fits together
```
visitor ── 443 ──> Caddy (systemd, /etc/caddy)
                     │  /etc/caddy/Caddyfile  =  import /etc/caddy/sites/*.caddy
                     ├─ sites/svc-agent.caddy      140-238-251-141.sslip.io        → 127.0.0.1:8080 (Docker)
                     ├─ sites/voltas-alerts.caddy  alerts.140-238-251-141.sslip.io → 127.0.0.1:8000 (systemd)
                     └─ sites/<name>.caddy         <name>.140-238-251-141.sslip.io → a port, or /var/www/<name>
```
- **Apps listen on `127.0.0.1` only.** Caddy is the one way in, so a site can't be reached around HTTPS.
- **One proxy hop:** apps should trust `X-Forwarded-For` / `-Proto` from one hop only, e.g. Express `trust proxy 1` or uvicorn `--proxy-headers --forwarded-allow-ips=127.0.0.1`.
- **Isolation:** each app has its own container or service user, its own data and its own secrets. One site crashing doesn't affect the others.

### Port register
Pick the next free port for a new app and add a row here in the same PR.

| Port | Site | Runs as | Repo |
|---|---|---|---|
| 8000 | `alerts.` (Voltas alert dashboard) | systemd `voltas-alerts`, Python | `Shashank-Codes-bit/Email_Alert-Dashboard` |
| 8080 | root (service bot) | Docker `svc-agent` | `Shashank-Codes-bit/Service-Call-Bot` |
| 8100 | *next free* | | |

## Setting up the VM (done once; safe to re-run)
```bash
git clone https://github.com/Shashank-Codes-bit/Service-Call-Bot ~/Service-Call-Bot
sudo bash ~/Service-Call-Bot/infra/oracle-vm/setup.sh 140-238-251-141.sslip.io
```
This:
- opens 80 and 443 in iptables (saved only if a rule was added);
- installs Docker if missing, and adds `ubuntu` to the `docker` group (log out and in once);
- installs Caddy;
- writes the import-only `/etc/caddy/Caddyfile`, plus `/etc/caddy/sites/`, `/var/www/` and `/etc/caddy/root-domain`.

## Adding a site
```bash
sudo bash ~/Service-Call-Bot/infra/oracle-vm/add-site.sh <name> proxy <port>        # an app on 127.0.0.1:<port>
sudo bash ~/Service-Call-Bot/infra/oracle-vm/add-site.sh <name> static /var/www/<name>
sudo bash ~/Service-Call-Bot/infra/oracle-vm/add-site.sh <name> remove
```
- The site goes live at `https://<name>.140-238-251-141.sslip.io`. Use `--host <hostname>` for a different name, such as a real domain whose A record points at the IP.
- The whole config is **validated before Caddy reloads**. A mistake, such as a name already in use, is rejected and the previous file is put back, so the other sites never go down.
- The first visit fetches the certificate, which takes a few seconds.

### A static site (HTML, or a React/Vite/Next static export)
1. Build locally (`dist/`, `build/` or `out/`, with an `index.html`).
2. Copy it to the VM: `scp -i <key> -r dist/* ubuntu@140.238.251.141:/tmp/<name>/`.
3. On the VM, run `sudo mkdir -p /var/www/<name> && sudo cp -r /tmp/<name>/* /var/www/<name>/`.
4. Register it: `add-site.sh <name> static /var/www/<name>`.

Unknown paths fall back to `index.html`, so client-side routes work. To update, copy the new build over; no reload is needed.

### An app in Docker (Node, Python, …)
Requirements:
- **Images must run on linux/arm64.** The official `node:*-slim` and `python:*-slim` images are multi-arch.
- Listen on `0.0.0.0` inside the container on a port from `PORT`.
- Secrets go in a gitignored `.env` on the VM only. Data goes in a named volume.

`deploy/compose.yaml` in the app's repo:
```yaml
name: <name>
services:
  web:
    build: { context: .. }
    restart: unless-stopped
    env_file: .env
    environment: { PORT: "8100" }
    ports: ["127.0.0.1:8100:8100"]     # localhost only; the port from the register
    # volumes: [ data:/data ]
# volumes: { data: {} }
```
Then on the VM:
```bash
git clone https://github.com/<me>/<repo> ~/<name> && cd ~/<name>/deploy
nano .env                              # if it needs secrets
docker compose up -d --build
sudo bash ~/Service-Call-Bot/infra/oracle-vm/add-site.sh <name> proxy 8100
```
To update: `git pull && docker compose up -d --build`.

### An app as a systemd service
Bind it to `127.0.0.1:<port>` and use `add-site.sh <name> proxy <port>`. Or, as the alert dashboard does, have the app's own setup write `/etc/caddy/sites/<name>.caddy`. It should validate with `caddy validate --config /etc/caddy/Caddyfile` before `systemctl reload caddy`.

## Day to day
| Task | Command (on the VM) |
|---|---|
| Which sites exist | `ls /etc/caddy/sites/` |
| Caddy log (certificates, 502s) | `journalctl -u caddy -f` |
| Reload after editing a site file by hand | `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy` |
| Docker apps | `docker ps`; in the app's folder, `docker compose logs -f` |
| Memory and disk | `free -h`, `df -h`, `docker system df` |

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| SSH `Connection timed out` | The Voltas VPN is on. Disconnect it. |
| `502 Bad Gateway` on a site | Its app isn't running or isn't on the port in its site file. Check `curl -s 127.0.0.1:<port>` on the VM. |
| Certificate error on a new site | Check `journalctl -u caddy`. Ports 80 and 443 must stay open in both firewalls. |
| `add-site.sh`: "Caddy rejected the change" | Usually the hostname is already another site's. Pick another name or `--host`. |
| Build fails with "exec format error" | An amd64-only image or binary. Use multi-arch images. |
| Running out of memory | All sites share 6 GB. The VM can grow to 2 OCPU / 12 GB at no cost (stop it, then Edit shape). |

## Limits and rules
- **Always Free:** 2 Arm VMs (2 OCPU / 12 GB in total), 2 AMD micro VMs, **200 GB** of disk (at least 47 GB per boot volume), 2 VCNs, 10 TB/month outbound.
- Only create things labelled **Always Free-eligible**. On Pay As You Go, set a $1 budget alert.
- Oracle can stop Always Free VMs that stay idle (under 20% CPU, network and memory) for 7 days. The disk is kept.
- Never commit secrets.
- Never run `docker compose down -v` on a project whose data matters: it deletes its volumes.
