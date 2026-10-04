#!/usr/bin/env bash
# PrepMyJob — réapplique la configuration nginx du dépôt (en-têtes de sécurité, page 404, cache) puis remet le HTTPS
# sans redemander de certificat. À lancer en root après un "git pull" qui modifie deploy/nginx-prepmyjob.conf.
# En cas d'échec, l'ancienne configuration est restaurée automatiquement.
set -euo pipefail
APP=/var/www/prepmyjob
if [ -d /etc/nginx/sites-available ]; then CONF=/etc/nginx/sites-available/prepmyjob; else CONF=/etc/nginx/conf.d/prepmyjob.conf; fi
BAK="/root/prepmyjob-nginx.bak.$(date +%Y%m%d%H%M%S)"

cp "$CONF" "$BAK"
restore() {
  echo "ÉCHEC : restauration de l'ancienne configuration ($BAK)."
  cp "$BAK" "$CONF"
  nginx -t && systemctl reload nginx
  exit 1
}
trap restore ERR

cp "$APP/deploy/nginx-prepmyjob.conf" "$CONF"
if [ -d /etc/letsencrypt/live/prepmyjob.com ]; then
  certbot install --nginx --cert-name prepmyjob.com -d prepmyjob.com -d www.prepmyjob.com --redirect --non-interactive
fi
nginx -t
systemctl reload nginx
trap - ERR
echo "nginx mis à jour (sauvegarde : $BAK)."
curl -sI https://prepmyjob.com/ | grep -i -E "^HTTP|strict-transport|x-content-type|referrer-policy|x-frame|permissions" || true
