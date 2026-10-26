#!/bin/sh
# Build here, ship the builds to Jinx, restart the unit. Re-runnable, no root beyond the
# webdeploy sudo rules. Shape follows FRC/DEPLOY.md ("private or no-remote repo").
#
# The first run also installs the unit, the site block and /etc/apps/haggle.env
# (DATABASE_URL from FRC/jinx/bootstrap.sh, ADMIN_TOKEN generated on the box).
# The server migrates an empty database itself. Cloudflare tunnel, by hand:
# haggle.futile.studio -> http://localhost:80
set -eu
cd "$(dirname "$0")/.."
HOST=${HOST:-ssh.futile.studio}
NAME=haggle

# Ship committed code only, so uncommitted work never goes live by accident.
if git rev-parse --verify -q HEAD >/dev/null; then
  BUILD=$(mktemp -d)
  trap 'rm -rf "$BUILD"' EXIT
  git archive HEAD | tar x -C "$BUILD"
  cd "$BUILD"
fi
npm ci
npm run build

scp -q deploy/haggle.caddy deploy/haggle.service "$HOST":/tmp/
ssh "$HOST" "NAME=haggle sh -s" <<'BOX'
set -eu
ENV=/etc/apps/$NAME.env
sudo -n touch "$ENV" && sudo -n chmod 600 "$ENV"
# Add a key only when it is missing, so a rerun never rotates a secret.
add() { sudo -n grep -q "^$1=" "$ENV" || echo "$1=$2" | sudo -n tee -a "$ENV" >/dev/null; }
add TRUST_PROXY true
add ADMIN_TOKEN "$(openssl rand -hex 24)"
sudo -n grep -q "^DATABASE_URL=" "$ENV" || { echo "$NAME: no DATABASE_URL in $ENV, run jinx/bootstrap.sh first" >&2; exit 1; }

if ! cmp -s "/tmp/$NAME.service" "/etc/systemd/system/$NAME.service"; then
  sudo -n install -m 644 "/tmp/$NAME.service" "/etc/systemd/system/$NAME.service"
  sudo -n systemctl daemon-reload
  sudo -n systemctl enable -q "$NAME"
fi
rm -f "/tmp/$NAME.service"

LIVE=/etc/caddy/conf.d/haggle.caddy
IN=/tmp/haggle.caddy
if cmp -s "$IN" "$LIVE"; then
  rm -f "$IN"
else
  # Imported into the config serving every site: validate, and restore on failure.
  sudo -n cp "$LIVE" "$IN.prev" 2>/dev/null || true
  sudo -n install -m 644 "$IN" "$LIVE" && rm -f "$IN"
  if ! caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    if [ -f "$IN.prev" ]; then sudo -n mv "$IN.prev" "$LIVE"; else sudo -n rm -f "$LIVE"; fi
    echo "$NAME: site block rejected by caddy validate, config unchanged" >&2
    exit 1
  fi
  sudo -n rm -f "$IN.prev"
  sudo -n systemctl reload caddy
fi
BOX

rsync -a --delete --relative package.json package-lock.json apps/server/package.json apps/server/dist apps/web/package.json apps/web/dist $HOST:/opt/apps/Haggle/
ssh $HOST "cd /opt/apps/Haggle && npm ci --omit=dev -w apps/server --include-workspace-root && sudo -n systemctl restart $NAME"

sleep 3
code=$(ssh $HOST 'curl -s -o /dev/null -w "%{http_code}" -H "Host: haggle.futile.studio" http://127.0.0.1/healthz' || true)
[ "$code" = "200" ] || { echo "$NAME: not healthy through Caddy (HTTP $code)"; exit 1; }
echo "$NAME: deployed to https://haggle.futile.studio"
