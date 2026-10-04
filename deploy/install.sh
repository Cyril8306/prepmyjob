#!/usr/bin/env bash
# PrepMyJob — installation (1re fois) ou mise à jour sur le serveur KVM2.
# À lancer en root :  bash /var/www/prepmyjob/deploy/install.sh   (ou la ligne curl donnée par Claude)
set -euo pipefail

APP=/var/www/prepmyjob
REPO=https://github.com/Cyril8306/prepmyjob.git
DOMAIN=prepmyjob.com
SERVER_IP=$(curl -4 -s --max-time 10 https://ifconfig.me || hostname -I | awk '{print $1}')

echo "== 1/5 Code =="
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone "$REPO" "$APP"; fi
cd "$APP"

echo "== 2/5 Clé API (jamais écrite dans le dépôt) =="
if [ ! -f .env ]; then
  read -rsp "Colle ta NOUVELLE clé API Anthropic (rien ne s'affiche), puis Entrée : " K; echo
  [ -n "$K" ] || { echo "Clé vide, arrêt."; exit 1; }
  umask 077
  printf 'ANTHROPIC_API_KEY=%s\nMODEL=claude-sonnet-4-6\nPORT=5100\nPER_IP_DAY=60\nGLOBAL_DAY=400\n' "$K" > .env
  echo ".env créé."
else
  echo ".env déjà présent : conservé."
fi

echo "== 3/5 Relais IA (pm2) =="
node -v
pm2 startOrReload ecosystem.config.cjs --update-env 2>/dev/null || pm2 start ecosystem.config.cjs
pm2 save
sleep 2
curl -s http://127.0.0.1:5100/api/health; echo

echo "== 4/5 nginx (seulement à la 1re installation, pour ne pas écraser le HTTPS de certbot) =="
if [ -d /etc/nginx/sites-available ]; then
  CONF=/etc/nginx/sites-available/prepmyjob
  if [ ! -f "$CONF" ]; then cp deploy/nginx-prepmyjob.conf "$CONF"; ln -sf "$CONF" /etc/nginx/sites-enabled/prepmyjob; echo "configuration installée"; fi
else
  CONF=/etc/nginx/conf.d/prepmyjob.conf
  if [ ! -f "$CONF" ]; then cp deploy/nginx-prepmyjob.conf "$CONF"; echo "configuration installée"; fi
fi
nginx -t
systemctl reload nginx

echo "== 5/5 HTTPS =="
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "Certificat déjà présent."
else
  DNS_OK=1
  for d in $DOMAIN www.$DOMAIN; do
    ip=$(getent ahostsv4 "$d" | awk '{print $1; exit}')
    if [ "$ip" != "$SERVER_IP" ]; then echo "ATTENTION : $d pointe sur '$ip' au lieu de $SERVER_IP : le HTTPS sera installé quand le DNS sera à jour (relance ce script)."; DNS_OK=0; fi
  done
  if [ "$DNS_OK" = 1 ]; then
    certbot --nginx -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos -m cyril.cretin83@gmail.com --redirect
  fi
fi
echo "Terminé. Test : https://$DOMAIN"
