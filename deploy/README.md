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
sudo -u ghostrace git fetch --depth 1 origin main
sudo -u ghostrace git checkout -B main FETCH_HEAD
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

**Status:** done for the current box — `64.177.44.73/32` is listed and
`/api/health` reports `"store":"mongo"`. The box egresses from exactly that
address and has no IPv6, so a single `/32` is sufficient; if the entry is
`0.0.0.0/0`, tighten it.

**The field is per-track, and the track id changed.** Runs are stored under the
track's own `id` (`geom.def.id`), not the filename. The Buggy Course is
`buggy-3lap-v1`, so the 25 runs seeded under the old `circuit-01` are invisible
to it — deploying the new course gives a correct but *empty* grid: no ghosts, no
matchmade rival, no leaderboard. Re-seed after deploying a new track, or the
demo is a lone car on an empty circuit.

## 6. Seed the field

Matchmaking needs opponents before the first player of the day arrives.

```bash
API_BASE=https://YOUR-DOMAIN npm run seed
```

## 7. Updating a running instance

`main` is the deployed branch. Deploy from it and nothing else.

```bash
sudo /opt/ghostrace/deploy/update.sh          # or: ... update.sh main <commit>
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

Given a commit as the second argument it deploys exactly that commit. CI passes
it the SHA it just verified, so two merges landing close together cannot deploy
the second one's code under the first one's green tick.

**Why the script uses `checkout -B` and not `reset --hard`.** `reset --hard
FETCH_HEAD` does not rename the branch: it moves whatever branch is checked out
onto the fetched commit, so a box provisioned against some other branch keeps
that branch's *name* while silently carrying `main`'s code, and `git status`
then reassures you about a branch that no longer means anything. If you are
poking at the box by hand, check what is actually checked out:

```bash
sudo -u ghostrace git -C /opt/ghostrace branch -vv
```

Gitignored files - `.env`, `atlas-credentials.env`, and the ~18MB of MediaPipe
assets under `client/public/mediapipe` - survive a branch switch, so neither the
secrets nor `npm run fetch-assets` need redoing.

Smoke-test after any manual deploy; a build that compiles is not a demo that
works:

```bash
curl -s https://YOUR-DOMAIN/api/health          # ok:true, and "store"
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR-DOMAIN/
```

## 8. Auto-deploy from CI (optional)

With this configured, a merge to `main` that passes CI deploys itself. Without
it, nothing breaks: the deploy job sees no `DEPLOY_HOST` and skips.

**On the box.** The CI job needs a user it can SSH in as, and permission to run
exactly one command as root:

```bash
sudo useradd -m -s /bin/bash deploy
sudo -u deploy mkdir -p ~deploy/.ssh && sudo -u deploy chmod 700 ~deploy/.ssh
ssh-keygen -t ed25519 -f /tmp/gh-deploy -N '' -C 'github-actions'
sudo tee -a ~deploy/.ssh/authorized_keys < /tmp/gh-deploy.pub
sudo chown deploy:deploy ~deploy/.ssh/authorized_keys
sudo chmod 600 ~deploy/.ssh/authorized_keys
```

Install the update script somewhere **root owns**, and grant sudo to that path
only:

```bash
sudo install -m 755 -o root -g root /opt/ghostrace/deploy/update.sh \
  /usr/local/sbin/ghostrace-update

printf 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/ghostrace-update\n' \
  | sudo tee /etc/sudoers.d/ghostrace-deploy
sudo chmod 440 /etc/sudoers.d/ghostrace-deploy
sudo visudo -c
```

The copy matters. Granting `NOPASSWD` on `/opt/ghostrace/deploy/update.sh`
would point sudo at a file inside the tree the deploy itself rewrites, which
turns "can deploy" into "can run anything as root" the moment someone lands a
commit editing that script. **The consequence of the copy is that changes to
`update.sh` do not take effect until you re-run the `install` line above** - the
script prints its own mtime on every run so the drift is visible in the CI log.

**In GitHub** (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the box's hostname or IP |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | contents of `/tmp/gh-deploy` (the **private** key) |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 YOUR-HOST` |

Then `rm /tmp/gh-deploy*` on the box. `DEPLOY_KNOWN_HOSTS` is not optional
padding: without a pinned host key the job would have to accept whatever answers
on port 22, and it is handing over a key that can restart the service.

Fork PRs never receive these - GitHub withholds secrets from fork workflows, and
the deploy job only runs on `push` to `main` anyway.

### Stopping a deploy landing at a bad moment

```bash
echo 'demo in progress - ethan' | sudo tee /opt/ghostrace/DEPLOY_HOLD
```

Any deploy while that file exists declines with exit 75; CI goes green with a
warning that production is behind `main`, rather than red. Delete the file to
resume, then deploy the backlog with `sudo ghostrace-update`.

A deploy also declines while any multiplayer room is open — `/api/health`
reports the count, so this is an exact answer to "is anyone mid-race", not a
guess. It is on by default and clears itself when the last player leaves; set
`SKIP_IF_BUSY=0` to turn it off.

For a wider unattended window, set a quiet period in
`/etc/default/ghostrace-deploy`:

```bash
QUIET_MINUTES=15
```

A deploy then declines if anyone finished a run in the last 15 minutes. This
catches solo play, where there is no room to count. It defaults to `0` (off), because a busy box would
otherwise never deploy at all. Every failure of the check - endpoint down,
unparseable response, no runs yet - is treated as "quiet", so a broken health
endpoint cannot wedge deploys permanently.

`FORCE=1 sudo ghostrace-update` overrides both.

### A human gate instead

The deploy job runs in a `production` environment. Adding a required reviewer to
that environment (Settings → Environments → production) makes every deploy wait
for an approval click, with no change to the workflow.

## 9. Check it on the demo machine itself

Open the site in the actual browser you will demo with, allow the camera, and
watch the debug overlay (`D`). If `latency p50` is above 100ms, the webcam is
almost certainly the bottleneck - see the tuning notes in the root README.
