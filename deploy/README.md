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
sudo apt update && sudo apt install -y nodejs npm caddy git
sudo useradd -r -s /bin/false -d /opt/ghostrace ghostrace
sudo mkdir -p /opt/ghostrace && sudo chown ghostrace /opt/ghostrace
```

## 3. Application

```bash
git clone <your-repo> /opt/ghostrace && cd /opt/ghostrace
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

## 5. Seed the field

Matchmaking needs opponents before the first player of the day arrives.

```bash
API_BASE=https://YOUR-DOMAIN npm run seed
```

## 6. Check it on the demo machine itself

Open the site in the actual browser you will demo with, allow the camera, and
watch the debug overlay (`D`). If `latency p50` is above 100ms, the webcam is
almost certainly the bottleneck - see the tuning notes in the root README.
