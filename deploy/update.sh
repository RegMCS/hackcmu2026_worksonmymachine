#!/usr/bin/env bash
# Deploy a commit and restart the service.
#
#   sudo /usr/local/sbin/ghostrace-update [branch] [commit]
#
# Run by hand, or by the deploy job in .github/workflows/ci.yml after CI passes
# on main. When a commit is given it is deployed exactly, rather than whatever
# happens to be at the tip of the branch by the time this runs - two merges
# landing close together must not deploy the second one's code under the first
# one's green tick.
#
# Exit codes: 0 deployed (or already current), 75 declined on purpose, 1 failed.

set -euo pipefail

# Box-local settings. This is the only way to set QUIET_MINUTES for automatic
# deploys: the CI job reaches this script through sudo, which strips the
# environment, so the knob has to live on the box rather than in the workflow.
# shellcheck source=/dev/null
[ -r /etc/default/ghostrace-deploy ] && . /etc/default/ghostrace-deploy

APP_DIR=${APP_DIR:-/opt/ghostrace}
APP_USER=${APP_USER:-ghostrace}
SERVICE=${SERVICE:-ghostrace}
BRANCH=${1:-main}
COMMIT=${2:-}
HEALTH_URL=${HEALTH_URL:-http://localhost:8787/api/health}
RECENT_URL=${RECENT_URL:-http://localhost:8787/api/recent}
# Minutes of no completed runs required before an automatic deploy proceeds.
# 0 disables the check. Turn it up on demo day; see deploy/README.md.
QUIET_MINUTES=${QUIET_MINUTES:-0}
FORCE=${FORCE:-0}

echo "ghostrace-update $(date -u +%FT%TZ)  script mtime $(date -u -r "$0" +%FT%TZ 2>/dev/null || echo '?')"

cd "$APP_DIR"

# Every write to the working tree runs as the service user. A root-owned
# node_modules or dist would look fine now and break the next unattended run.
as_app() { sudo -u "$APP_USER" "$@"; }

# --- Reasons to decline -----------------------------------------------------
# A hold file is the switch for "someone is standing in front of this box".
# Checked before the fetch so holding costs nothing.
if [ -e "$APP_DIR/DEPLOY_HOLD" ] && [ "$FORCE" != 1 ]; then
  echo "DECLINED: $APP_DIR/DEPLOY_HOLD exists."
  cat "$APP_DIR/DEPLOY_HOLD" 2>/dev/null || true
  echo "Remove it to resume deploys, or re-run with FORCE=1."
  exit 75
fi

# A restart drops every in-flight connection, and since the multiplayer relay
# shares the API port that now means ending live races, not just a reload.
# /api/health reports the open room count, which is an exact answer to "is
# anyone mid-race right now" - so this one is on by default. It clears itself
# when the last player leaves; DEPLOY_HOLD is the switch for a longer freeze.
if [ "${SKIP_IF_BUSY:-1}" != 0 ] && [ "$FORCE" != 1 ]; then
  health=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || echo '')
  if [ -n "$health" ]; then
    rooms=$(printf '%s' "$health" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try { const h = JSON.parse(s); console.log(Number(h?.rooms) || 0); }
        catch { console.log(0); }   // unreadable health: fail open, not stuck
      });' 2>/dev/null || echo 0)
    if [ "$rooms" -gt 0 ]; then
      echo "DECLINED: $rooms multiplayer room(s) open - a restart would end them."
      exit 75
    fi
  fi
fi

# A completed run in the last few minutes means someone is playing solo, where
# there is no room to count.
if [ "$QUIET_MINUTES" != 0 ] && [ "$FORCE" != 1 ]; then
  recent=$(curl -fsS --max-time 5 "$RECENT_URL" 2>/dev/null || echo '')
  if [ -n "$recent" ]; then
    age=$(printf '%s' "$recent" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const r = JSON.parse(s);
          // No runs yet, or a store with nothing in it: nobody is playing.
          if (!r || !r.createdAt) return console.log(999999);
          console.log(Math.floor((Date.now() - Date.parse(r.createdAt)) / 60000));
        } catch { console.log(999999); }
      });' 2>/dev/null || echo 999999)
    if [ "$age" -lt "$QUIET_MINUTES" ]; then
      echo "DECLINED: a run finished ${age}m ago, quiet window is ${QUIET_MINUTES}m."
      exit 75
    fi
  fi
fi

# --- Fetch ------------------------------------------------------------------
previous=$(as_app git rev-parse --short HEAD 2>/dev/null || echo none)
echo "current: $previous"

if [ -n "$COMMIT" ]; then
  as_app git fetch --depth 1 origin "$COMMIT"
else
  as_app git fetch --depth 1 origin "$BRANCH"
fi
target=$(as_app git rev-parse --short FETCH_HEAD)

if [ "$target" = "$previous" ]; then
  echo "already at $target - nothing to do"
  exit 0
fi
echo "updating: $previous -> $target"

as_app git checkout -B "$BRANCH" FETCH_HEAD
as_app npm ci
as_app npm run fetch-assets   # no-op once the model is on disk
as_app npm run build

# The restart is last on purpose: set -e means a failed build leaves the old
# dist in place and the running service untouched, so a bad commit is a failed
# script rather than a dark site.
systemctl restart "$SERVICE"

# systemctl returns as soon as the process is spawned, which is before Express
# is listening and before the Mongo handshake. Poll the real thing instead.
for i in $(seq 1 20); do
  if body=$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null); then
    echo "healthy after ${i}s: $body"
    # An Atlas source-IP rejection surfaces here as a silent downgrade to the
    # file store: the game plays, but runs live on this box alone.
    case "$body" in
      *'"store":"file"'*|*'"store": "file"'*)
        echo "WARNING: store is 'file', not 'mongo'. Check Atlas > Network Access" >&2 ;;
    esac
    exit 0
  fi
  sleep 1
done

echo "FAIL: $SERVICE did not become healthy." >&2
if [ "$previous" = none ]; then
  journalctl -u "$SERVICE" -n 40 --no-pager >&2
  exit 1
fi
echo "rolling back to $previous" >&2
as_app git checkout -B "$BRANCH" "$previous"
as_app npm ci && as_app npm run build
systemctl restart "$SERVICE"
journalctl -u "$SERVICE" -n 40 --no-pager >&2
exit 1
