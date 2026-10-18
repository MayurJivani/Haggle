#!/bin/sh
# Build here, ship the builds to Jinx, restart the unit. Re-runnable, no root beyond the
# webdeploy sudo rules. Shape follows FRC/DEPLOY.md ("private or no-remote repo").
#
# First deploy only (by hand, on the box):
#   sudo -u postgres createuser haggle -P && sudo -u postgres createdb -O haggle haggle
#   /etc/apps/haggle.env (chmod 600): DATABASE_URL, ADMIN_TOKEN, TRUST_PROXY=true
#   sudo install -m 644 deploy/haggle.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable haggle
#   Cloudflare tunnel: haggle.futile.studio -> http://localhost:80
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

scp -q deploy/$NAME.caddy $HOST:/tmp/$NAME.caddy.incoming
ssh $HOST "
  set -eu
  LIVE=/etc/caddy/conf.d/$NAME.caddy
  IN=/tmp/$NAME.caddy.incoming
  if cmp -s \"\$IN\" \"\$LIVE\"; then
    rm -f \"\$IN\"
  else
    # The block is imported into the config serving every site: validate, and restore on failure.
    sudo -n cp \"\$LIVE\" \"\$LIVE.prev\" 2>/dev/null || true
    sudo -n install -m 644 \"\$IN\" \"\$LIVE\"
    rm -f \"\$IN\"
    if ! caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
      if [ -f \"\$LIVE.prev\" ]; then sudo -n mv \"\$LIVE.prev\" \"\$LIVE\"; else sudo -n rm -f \"\$LIVE\"; fi
      echo '$NAME: site block rejected by caddy validate, config unchanged' >&2
      exit 1
    fi
    sudo -n rm -f \"\$LIVE.prev\"
    sudo -n systemctl reload caddy
  fi
"

rsync -a --delete --relative package.json package-lock.json apps/server/package.json apps/server/dist apps/web/package.json apps/web/dist $HOST:/opt/apps/Haggle/
ssh $HOST "cd /opt/apps/Haggle && npm ci --omit=dev -w apps/server --include-workspace-root && sudo -n systemctl restart $NAME"

sleep 3
code=$(ssh $HOST 'curl -s -o /dev/null -w "%{http_code}" -H "Host: haggle.futile.studio" http://127.0.0.1/healthz' || true)
[ "$code" = "200" ] || { echo "$NAME: not healthy through Caddy (HTTP $code)"; exit 1; }
echo "$NAME: deployed to https://haggle.futile.studio"
