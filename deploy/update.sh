#!/usr/bin/env bash
# Pull the current commit and restart the service, replacing the hand-typed
# sequence in deploy/README.md section 3.
#
#   sudo /opt/ghostrace/deploy/update.sh [branch]
#
# Deliberately manual: there is no webhook and no auto-deploy. The box that
# serves the demo is the box someone is standing in front of, and a push that
# lands mid-race is worse than a deploy that waits five minutes.

set -euo pipefail

APP_DIR=${APP_DIR:-/opt/ghostrace}
APP_USER=${APP_USER:-ghostrace}
SERVICE=${SERVICE:-ghostrace}
BRANCH=${1:-ghostrace}
HEALTH_URL=${HEALTH_URL:-http://localhost:8787/api/health}

cd "$APP_DIR"

# Every write to the working tree runs as the service user. A root-owned
# node_modules or dist would look fine now and break the next unattended run.
as_app() { sudo -u "$APP_USER" "$@"; }

previous=$(as_app git rev-parse --short HEAD 2>/dev/null || echo none)
echo "current: $previous"

as_app git fetch --depth 1 origin "$BRANCH"
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
