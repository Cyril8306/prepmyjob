#!/usr/bin/env bash
# Remplace la clé API Anthropic du serveur (saisie masquée), la teste AVANT de l'enregistrer, puis relance le relais.
# À lancer en root :  cd /var/www/prepmyjob && git pull && bash deploy/set-anthropic-key.sh
set -euo pipefail
APP=/var/www/prepmyjob
cd "$APP"

tester() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 'https://api.anthropic.com/v1/models?limit=1' -H "x-api-key: $1" -H 'anthropic-version: 2023-06-01' || true; }

echo "== 1/3 Clé actuelle =="
CUR=$(grep -m1 '^ANTHROPIC_API_KEY=' .env 2>/dev/null | cut -d= -f2- || true)
code=$(tester "$CUR")
if [ "$code" = "200" ]; then echo "La clé actuelle fonctionne (HTTP 200)."; else echo "La clé actuelle est refusée par Anthropic (HTTP $code)."; fi

echo "== 2/3 Nouvelle clé =="
read -rsp "Colle ta NOUVELLE clé API Anthropic (sk-ant-..., rien ne s'affiche), ou Entrée pour garder l'actuelle : " K; echo
if [ -n "$K" ]; then
  code=$(tester "$K")
  if [ "$code" != "200" ]; then echo "Cette clé est refusée par Anthropic (HTTP $code) : rien n'a été modifié."; exit 1; fi
  BAK="/root/prepmyjob-env.bak.$(date +%Y%m%d%H%M%S)"
  cp .env "$BAK" && chmod 600 "$BAK"
  grep -v '^ANTHROPIC_API_KEY=' .env > .env.tmp || true
  printf 'ANTHROPIC_API_KEY=%s\n' "$K" >> .env.tmp
  mv .env.tmp .env && chmod 600 .env
  echo "Clé testée (HTTP 200) et enregistrée. Ancien fichier sauvegardé dans $BAK."
fi

echo "== 3/3 Redémarrage du relais =="
# env -u : une variable ANTHROPIC_API_KEY restée dans le terminal ne doit pas masquer celle du fichier .env
env -u ANTHROPIC_API_KEY pm2 delete prepmyjob >/dev/null 2>&1 || true
env -u ANTHROPIC_API_KEY pm2 start ecosystem.config.cjs >/dev/null
pm2 save >/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do
  h=$(curl -s --max-time 5 http://127.0.0.1:5100/api/health || true)
  case "$h" in *'"ia":true'*) echo "$h"; echo "Terminé : l'IA répond."; exit 0;; esac
  sleep 2
done
echo "$h"
echo "ATTENTION : le relais ne confirme pas encore l'IA (champ ia). Envoie cette sortie à Claude."
