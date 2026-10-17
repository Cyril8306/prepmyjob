#!/bin/bash
# Redirige prepmyjob.fr et www.prepmyjob.fr vers https://prepmyjob.com (301, chemin conservé), avec un certificat HTTPS.
# À lancer en root, une fois que le DNS de prepmyjob.fr pointe vers ce serveur :
#   cd /var/www/prepmyjob && git pull && bash deploy/redirect-fr.sh
# Relançable sans risque : il ne remplace pas une configuration déjà complétée par certbot.
set -e
APP=/var/www/prepmyjob
IPS=" $(hostname -I) "

echo "== 1/4 DNS de prepmyjob.fr"
for i in $(seq 1 40); do
  A=$(getent ahostsv4 prepmyjob.fr | awk 'NR==1{print $1}')
  W=$(getent ahostsv4 www.prepmyjob.fr | awk 'NR==1{print $1}')
  if [[ -n "$A" && "$IPS" == *" $A "* && -n "$W" && "$IPS" == *" $W "* ]]; then echo "OK : prepmyjob.fr -> $A"; break; fi
  if [ "$i" = 40 ]; then echo "ERREUR : prepmyjob.fr pointe encore vers ${A:-rien}, pas vers ce serveur. Rien n'a été modifié."; exit 1; fi
  echo "en attente du DNS (actuellement ${A:-rien})…"; sleep 15
done

echo "== 2/4 nginx"
if [ -d /etc/nginx/sites-available ]; then CONF=/etc/nginx/sites-available/prepmyjob-fr; LINK=/etc/nginx/sites-enabled/prepmyjob-fr; else CONF=/etc/nginx/conf.d/prepmyjob-fr.conf; LINK=""; fi
if [ -f "$CONF" ] && [ -d /etc/letsencrypt/live/prepmyjob.fr ]; then
  echo "configuration déjà en place (HTTPS compris) : conservée"
else
  cp "$APP/deploy/nginx-prepmyjob-fr.conf" "$CONF"
  if [ -n "$LINK" ]; then ln -sf "$CONF" "$LINK"; fi
  nginx -t
  systemctl reload nginx
  echo "configuration installée"
fi

echo "== 3/4 certificat HTTPS"
certbot --nginx --cert-name prepmyjob.fr -d prepmyjob.fr -d www.prepmyjob.fr --non-interactive --agree-tos -m cyril.cretin83@gmail.com --no-redirect --keep-until-expiring
nginx -t
systemctl reload nginx

echo "== 4/4 vérification"
for u in http://prepmyjob.fr/prix https://prepmyjob.fr/prix http://www.prepmyjob.fr/ https://www.prepmyjob.fr/; do
  printf '%s -> ' "$u"; curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' --max-time 10 "$u" || echo "échec"
done
echo "Terminé. Chaque ligne ci-dessus doit afficher 301 et une adresse https://prepmyjob.com/…"
