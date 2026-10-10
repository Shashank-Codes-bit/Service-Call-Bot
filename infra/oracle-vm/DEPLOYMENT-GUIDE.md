# Deploying on the shared Oracle VM: the complete guide

**For whoever deploys an app here, human or AI.** This one file holds everything about the server: what it is, how it was set up, how the sites already on it run, and the exact steps to add one more without disturbing the others. Paste it whole into a project's chat as its deployment context.

> **The golden rule:** this VM is shared. Several live sites run on it. **Add your own site; never change, stop or restart anyone else's.**

---

## 1. The machine

| | |
|---|---|
| Provider | Oracle Cloud **Always Free** (costs $0). Home region India West (Mumbai), `ap-mumbai-1` |
| VM name | `svc-agent` |
| Shape | `VM.Standard.A1.Flex`: **1 OCPU, 6 GB RAM, Arm64 (aarch64)** |
| OS | Ubuntu 24.04 |
| Public IP | `140.238.251.141` |
| Free hostnames | `140-238-251-141.sslip.io`, plus **any** `<name>.140-238-251-141.sslip.io`. sslip.io resolves these to the IP, so there's no DNS to set up and every name gets real HTTPS. |
| Network | VCN `svc-agent-vcn`, public subnet `10.0.0.0/24`, internet gateway |
| Open ports | **22 (SSH), 80, 443 only.** Opened in **two** places: the subnet's security list in the Oracle console, **and** the VM's own iptables. No site needs any other port opened. |
| Installed | Docker Engine + Compose plugin, **Caddy 2** (systemd service), iptables-persistent, git |
| Login | From Windows PowerShell: `ssh -i "$env:USERPROFILE\.ssh\oracle-svc-agent.key" ubuntu@140.238.251.141`. **Disconnect the Voltas VPN first**, or SSH times out. |

---

## 2. How it was built (done once; already in place)

1. **In the Oracle console:**
   - **Network:** created VCN `svc-agent-vcn` with a public subnet and an internet gateway. Added ingress rules to the subnet's security list: TCP **80** and **443** from `0.0.0.0/0` (22 is there by default).
   - **VM:** created the VM (`VM.Standard.A1.Flex`, Ubuntu 24.04, public IPv4) and downloaded its SSH private key to `C:\Users\<you>\.ssh\oracle-svc-agent.key`.
2. **Shared setup on the VM**, from the service bot's repo (safe to re-run; it changes nothing that's already right):
   ```bash
   git clone https://github.com/Shashank-Codes-bit/Service-Call-Bot ~/Service-Call-Bot
   sudo bash ~/Service-Call-Bot/infra/oracle-vm/setup.sh 140-238-251-141.sslip.io
   ```
   `setup.sh`:
   - **Firewall:** opens 80 and 443 in iptables, ahead of Oracle's default REJECT rule. Oracle's Ubuntu image blocks everything except SSH even when the console allows it. It saves the rules only if it added one.
   - **Docker:** installs Docker and the Compose plugin if missing, and adds `ubuntu` to the `docker` group.
   - **Caddy:** installs Caddy as the single HTTPS front door. It owns ports 80/443 and gets and renews a free certificate for every site automatically.
   - **The Caddyfile:** writes `/etc/caddy/Caddyfile` containing **only** `import /etc/caddy/sites/*.caddy`. Each website is **one small file** in `/etc/caddy/sites/`.
   - **Folders:** creates `/var/www/` for static sites, and `/etc/caddy/root-domain` (`140-238-251-141.sslip.io`).
3. **Site 1, the service bot.** A Node app in Docker, from `Service-Call-Bot/svc-agent/deploy/oracle/compose.yaml`:
   - **Port:** published on `127.0.0.1:8080` only.
   - **Data:** SQLite in the named volume `svc_data`, mounted at `/data`, so rebuilds keep the data.
   - **Secrets:** in `deploy/oracle/.env`, on the VM only and never committed.
   - **Registered with Caddy:** `sudo bash ~/Service-Call-Bot/infra/oracle-vm/add-site.sh svc-agent proxy 8080 --host 140-238-251-141.sslip.io`
4. **Site 2, the Voltas alert dashboard.** A Python app as a systemd service (`voltas-alerts`) on `127.0.0.1:8000`, at `alerts.140-238-251-141.sslip.io`. Its own setup script writes its Caddy site file.

---

## 3. How a visitor reaches each site

```
browser ── HTTPS :443 ──> Caddy   (/etc/caddy/Caddyfile = import /etc/caddy/sites/*.caddy)
                            ├─ svc-agent.caddy      140-238-251-141.sslip.io         → 127.0.0.1:8080  Docker  (service bot)
                            ├─ voltas-alerts.caddy  alerts.140-238-251-141.sslip.io  → 127.0.0.1:8000  systemd (alert dashboard)
                            └─ <name>.caddy         <name>.140-238-251-141.sslip.io  → 127.0.0.1:<port>  (your app)
```

- **Apps listen on `127.0.0.1` only.** Caddy is the only way in, so nothing can be reached around HTTPS.
- **One proxy hop.** Caddy sets `X-Forwarded-For` and `X-Forwarded-Proto`. Apps trust exactly **one** hop: Express `app.set('trust proxy', 1)`; uvicorn `--proxy-headers --forwarded-allow-ips=127.0.0.1`.
- **Isolation.** Each site has its own container or service, its own data, its own `.env` and its own port. One crashing doesn't affect the others.
- **`add-site.sh` validates the whole Caddy config before reloading.** If the change is wrong, such as a name already used, it puts the previous file back, so the other sites never go down.

---

## 4. The port register

Every app gets its own localhost port. **Take the next free one and record it here** (in `infra/oracle-vm/README.md` too).

| Port | Site | Runs as | Repo |
|---|---|---|---|
| 8000 | `alerts.140-238-251-141.sslip.io` (Voltas alert dashboard) | systemd `voltas-alerts`, Python | `Shashank-Codes-bit/Email_Alert-Dashboard` |
| 8080 | `140-238-251-141.sslip.io` (service bot) | Docker `svc-agent`, Node | `Shashank-Codes-bit/Service-Call-Bot` |
| **8100** | **next free: the next app takes this** | | |
| 8101 | free after that | | |

---

## 5. Deploying a new app with a server (Docker), step by step

Example name **`myapp`**, port **8100**. Replace both with yours. The site will be at **`https://myapp.140-238-251-141.sslip.io`**.

### 5.1 What the app must do
- **Listen on `0.0.0.0`** inside the container, on the port given in the **`PORT`** environment variable.
- **Trust one proxy hop**, as in section 3, so client IPs and `https` are seen correctly.
- **Read secrets from environment variables.** Never hard-code them or commit them.
- **Write data under `/data`** (SQLite files, uploads), so it lives in a volume and survives rebuilds.
- **Have a cheap health URL** (e.g. `/health` returning 200), for checking after deploys.

### 5.2 Files to add to the app's repo

**`Dockerfile`** at the repo root. Use official **slim** images: they're multi-arch, so they run on this Arm VM.

Node:
```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# If the app has a build step (React/Next/TypeScript), add it here, e.g.:
# RUN npm run build
ENV NODE_ENV=production
CMD ["node", "server.js"]            # the app's real start command
```

Python (FastAPI/uvicorn shown; adapt for Flask/gunicorn):
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips=127.0.0.1"]
```

**`deploy/compose.yaml`:**
```yaml
name: myapp
services:
  web:
    build: { context: .. }
    restart: unless-stopped            # comes back after crashes and VM reboots
    env_file: .env                     # secrets, on the VM only
    environment: { PORT: "8100" }
    ports: ["127.0.0.1:8100:8100"]     # localhost only — Caddy is the way in
    volumes: [ "data:/data" ]          # remove if the app stores nothing
volumes: { data: {} }
```

**`.gitignore`**: add `deploy/.env`.

Packages with native code must have **Linux Arm64** builds. Most do. If one doesn't, the build shows `exec format error` or tries to compile.

### 5.3 Commands on the VM
```bash
# 0. Is there room? All sites share 6 GB.
free -h

# 1. Get the code
git clone https://github.com/<owner>/<repo> ~/myapp
cd ~/myapp/deploy

# 2. Secrets — one KEY=value per line, never committed
nano .env

# 3. Build and start (the first build on Arm can take a few minutes)
docker compose up -d --build
docker compose ps                                   # State: running
curl -s -o /dev/null -w "%{http_code}\n" 127.0.0.1:8100/health   # expect 200

# 4. Put it on the internet through Caddy
sudo bash ~/Service-Call-Bot/infra/oracle-vm/add-site.sh myapp proxy 8100
#    → https://myapp.140-238-251-141.sslip.io   (first visit fetches the certificate: a few seconds)
```

### 5.4 Updating, logs, rollback
```bash
cd ~/myapp && git pull && cd deploy && docker compose up -d --build     # deploy a new version
docker compose logs -f web                                              # follow its logs
docker compose restart web                                              # restart only this app
git log --oneline -5 && git checkout <good-commit> && docker compose up -d --build   # roll back
sudo bash ~/Service-Call-Bot/infra/oracle-vm/add-site.sh myapp remove   # take it off the internet
```

---

## 6. Other kinds of site, in brief

- **Static site** (HTML, or a React/Vite/Next static export):
  1. Build it.
  2. `scp -i "$env:USERPROFILE\.ssh\oracle-svc-agent.key" -r dist\* ubuntu@140.238.251.141:/tmp/<name>/`
  3. On the VM: `sudo mkdir -p /var/www/<name> && sudo cp -r /tmp/<name>/* /var/www/<name>/`
  4. `sudo bash ~/Service-Call-Bot/infra/oracle-vm/add-site.sh <name> static /var/www/<name>`

  Unknown paths fall back to `index.html`, so client-side routes work. To update, copy the new build over the old one.
- **App as a systemd service:** bind it to `127.0.0.1:<port>`, then `add-site.sh <name> proxy <port>`.
- **Your own domain instead of sslip.io:** point the domain's DNS **A record** at `140.238.251.141`, then add `--host www.yourdomain.com` to the `add-site.sh` command.

---

## 7. The service bot, for reference

```bash
cd ~/Service-Call-Bot && git pull
cd svc-agent/deploy/oracle && docker compose up -d --build
docker compose exec app npm run vapi:setup         # only when its Vapi voice settings changed
docker compose exec app npm run calls -- shashank 3  # read recent test calls
```

---

## 8. Rules for a shared VM

1. **Arm64 only.** Use multi-arch images. An Intel-only image fails with `exec format error`.
2. **Never publish on `0.0.0.0`**, and never open new ports in Oracle or iptables. Everything goes through Caddy on 443.
3. **One site, one port, one `.env`, one data volume.** Record the port in the register.
4. **Don't touch other sites:**
   - never edit another site's file in `/etc/caddy/sites/`;
   - never stop or restart another project's containers or services;
   - never run `docker system prune -a`, which removes others' images.
5. **Never run `docker compose down -v`** on a project whose data matters: `-v` deletes its volumes.
6. **Memory:** 6 GB is shared. Check `free -h` before adding a heavy app. The VM can grow to **2 OCPU / 12 GB at no cost**: stop it in the console, **Edit shape**, start it.
7. **Secrets** only in each app's `.env` on the VM. Never in git, never in chat.
8. **Idle shutdown:** Oracle may stop an Always Free VM that's nearly idle for 7 days. The disk is kept; start it again from the console.
9. **Only Always Free resources.** Anything that isn't labelled "Always Free-eligible" costs money.

---

## 9. Day-to-day commands and troubleshooting

| Task | Command (on the VM) |
|---|---|
| Which sites exist | `ls /etc/caddy/sites/` |
| Caddy's log (certificates, 502s) | `journalctl -u caddy -f` |
| Reload Caddy after a hand edit | `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy` |
| All containers | `docker ps` |
| Memory and disk | `free -h` · `df -h` · `docker system df` |

| Symptom | Cause / fix |
|---|---|
| SSH `Connection timed out` | The Voltas VPN is on. Disconnect it. |
| `502 Bad Gateway` on your site | The app isn't running on the port in its site file. Check `docker compose ps` and `curl 127.0.0.1:<port>`. |
| `add-site.sh`: "Caddy rejected the change" | The name or host is already used by another site. Pick another name. Nothing else was affected. |
| Certificate error on a new site | Check `journalctl -u caddy`. Ports 80 and 443 must stay open in both firewalls. |
| Build: `exec format error` | An Intel-only image or binary. Use official multi-arch slim images. |
| App can't see the real `https` or client IP | Trust one proxy hop (section 3). |
| VM slow, containers killed | Out of memory: run `free -h`. Grow the VM to 12 GB (rule 6). |

---

## 10. Checklist before calling it deployed

- [ ] `docker compose ps` shows the app **running**, with `restart: unless-stopped`.
- [ ] `curl 127.0.0.1:<port>/health` on the VM returns 200.
- [ ] `https://<name>.140-238-251-141.sslip.io` opens in a browser with a valid certificate.
- [ ] The other sites still work: `https://140-238-251-141.sslip.io/health` and `https://alerts.140-238-251-141.sslip.io`.
- [ ] `.env` is on the VM only, and `git status` shows it isn't tracked.
- [ ] The port is recorded in the register: section 4 here, and `infra/oracle-vm/README.md`.
- [ ] `free -h` still shows comfortable headroom.
