# Deploying GhostRace to Vultr

Do the DNS step first. Everything else can be done in twenty minutes; DNS
propagation cannot be rushed, and without a domain there is no HTTPS, without
HTTPS there is no camera, and without a camera there is no game.

## 1. Domain (do this first)

Point an A record at your Vultr instance's IPv4 address. Let's Encrypt will not
issue a certificate for a bare IP, and self-signed certificates fail on iOS
Safari.

```
ghostrace.example.com.  A  203.0.113.10
```

Verify before continuing: `dig +short ghostrace.example.com`

## 2. Instance

Smallest Regular Cloud Compute instance, Ubuntu LTS, is enough - the server only
proxies the API and serves static files; all the real work happens in the
player's browser.

```bash
sudo apt update && sudo apt install -y git curl

# Node from NodeSource, not from apt. Ubuntu LTS ships a Node several major
# versions behind what package.json expects, and the mismatch does not surface
# until `npm run build` - the production build is the only place missing `.js`
# extensions in relative ESM imports actually fail. Match .nvmrc.
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # must satisfy the "engines" field in package.json

# Caddy from its own repo: the Ubuntu build lags several minor versions, and TLS
# issuance is the one component worth having current.
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo useradd -r -m -d /opt/ghostrace -s /usr/sbin/nologin ghostrace
```

**Open the firewall.** Vultr images ship with `ufw` active and only port 22 open.
Caddy will start happily and still be unreachable, and Let's Encrypt will never
validate, because the HTTP-01 challenge needs port 80 specifically:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw reload
```

**Harden SSH** once your key works. Note the drop-in must sort *before*
cloud-init's, because sshd uses first-match-wins - a `99-*.conf` is silently
overridden by `50-cloud-init.conf`:

```bash
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' \
  | sudo tee /etc/ssh/sshd_config.d/01-hardening.conf
sudo sed -i 's/^[[:space:]]*PasswordAuthentication.*/#/' /etc/ssh/sshd_config.d/50-cloud-init.conf
sudo sshd -t && sudo systemctl restart ssh
sudo sshd -T | grep -i passwordauthentication   # must say "no"
```

## 3. Application

`useradd -m` seeds skeleton dotfiles, so a plain `git clone` into the home
directory refuses. Initialise in place instead:

```bash
cd /opt/ghostrace
sudo -u ghostrace git init
sudo -u ghostrace git remote add origin <your-repo>
sudo -u ghostrace git fetch --depth 1 origin ghostrace
sudo -u ghostrace git checkout -B ghostrace FETCH_HEAD
npm ci
npm run fetch-assets      # self-hosts the MediaPipe wasm + model
npm run build
```

Create `/opt/ghostrace/.env` (see `.env.example`), then:

```bash
sudo cp deploy/ghostrace.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ghostrace
sudo systemctl status ghostrace
```

## 4. TLS

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/ghostrace.example.com/YOUR-DOMAIN/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Confirm: `curl -I https://YOUR-DOMAIN/api/health`

## 5. Atlas IP access list

Atlas rejects unlisted source IPs during the TLS handshake, so the failure looks
like a cryptic `SSL alert number 80` rather than an auth error. Add the Vultr
instance's public IP under **Atlas → Network Access**, then:

```bash
sudo systemctl restart ghostrace
curl -s https://YOUR-DOMAIN/api/health   # "store" must say "mongo", not "file"
```

Until that is done the server falls back to the local file store: the game plays
normally, but runs live on one box only.

## 6. Seed the field

Matchmaking needs opponents before the first player of the day arrives.

```bash
API_BASE=https://YOUR-DOMAIN npm run seed
```

## 7. Updating a running instance

Once the box is set up, `deploy/update.sh` replaces the sequence in section 3:

```bash
sudo /opt/ghostrace/deploy/update.sh          # or: ... update.sh some-branch
```

It fetches, reinstalls, rebuilds, restarts, then polls `/api/health` until the
server actually answers - `systemctl restart` returns as soon as the process is
spawned, which is well before Express is listening or Mongo has shaken hands. A
build failure aborts before the restart, so a bad commit is a failed script
rather than a dark site; a failed health check rolls back to the previous commit
and prints the journal.

It also warns when health reports `store: file`, which is how an Atlas source-IP
rejection actually presents itself - the game plays normally and the runs simply
stop being shared.

There is no webhook and no auto-deploy on push, deliberately: the box serving
the demo is the box someone is standing in front of. CI
(`.github/workflows/ci.yml`) tells you the commit is good; you choose when it
lands.

## 8. Check it on the demo machine itself

Open the site in the actual browser you will demo with, allow the camera, and
watch the debug overlay (`D`). If `latency p50` is above 100ms, the webcam is
almost certainly the bottleneck - see the tuning notes in the root README.
