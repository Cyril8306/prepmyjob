# PrepMyJob — déploiement sur le serveur KVM2 (Hostinger)

Architecture : nginx sert `public/` (pages statiques) et transmet `/api/` au relais Node `server/server.js` (pm2, port 5100, local).
La clé API Anthropic vit uniquement dans `/var/www/prepmyjob/.env` sur le serveur (jamais dans le dépôt).

Installation ou mise à jour (en root sur le serveur) :

    bash <(curl -fsSL https://raw.githubusercontent.com/Cyril8306/prepmyjob/main/deploy/install.sh)

Le script : clone/met à jour le code, crée `.env` (demande la clé, non affichée), lance le relais avec pm2,
installe la configuration nginx à la 1re installation, puis le HTTPS (certbot) si le DNS pointe sur le serveur.

Protections du relais : origine prepmyjob.com obligatoire, modèle imposé par le serveur (variable MODEL),
max_tokens plafonné, taille limitée, quota par IP (PER_IP_DAY) et plafond global par jour (GLOBAL_DAY).
