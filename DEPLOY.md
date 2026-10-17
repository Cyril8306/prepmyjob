# PrepMyJob — déploiement sur le serveur KVM2 (Hostinger)

Architecture : nginx sert `public/` (pages statiques) et transmet `/api/` au serveur Node `server/server.js` (pm2, port 5100, local).
Les secrets (clé API Anthropic, clé Stripe, mot de passe de la boîte contact@) vivent uniquement dans `/var/www/prepmyjob/.env`
sur le serveur, jamais dans le dépôt. Les pass et les rétractations sont dans `/var/www/prepmyjob/data/` (hors dépôt).

Première installation (en root sur le serveur) :

    bash <(curl -fsSL https://raw.githubusercontent.com/Cyril8306/prepmyjob/main/deploy/install.sh)

Mise à jour (en root sur le serveur) :

    cd /var/www/prepmyjob && git pull && bash deploy/install.sh

Le script : met à jour le code, crée `.env` (demande les secrets manquants, saisie masquée), relance le serveur avec pm2,
installe la configuration nginx à la 1re installation, puis le HTTPS (certbot) si le DNS pointe sur le serveur.
Il affiche à la fin `/api/health` : `configured` (IA), `paiement` (Stripe), `email` (connexion SMTP).

Protections : les consignes envoyées à l'IA sont écrites dans le serveur (la page n'envoie que ses données), origine prepmyjob.com
obligatoire, modèle imposé (variable MODEL), quotas gratuits par IP (PER_IP_DAY) et par jour (GLOBAL_DAY), étapes payantes
réservées au pass vérifié par le serveur.

Mise à jour des seules pages statiques : `cd /var/www/prepmyjob && git pull`.
Si `deploy/nginx-prepmyjob.conf` change : `bash deploy/update-nginx.sh` (réapplique nginx + HTTPS, restaure l'ancienne config en cas d'échec).
Redirection de prepmyjob.fr (et www) vers https://prepmyjob.com, une seule fois, après avoir fait pointer le DNS de prepmyjob.fr vers ce serveur : `bash deploy/redirect-fr.sh` (nginx + certificat HTTPS, 301 avec chemin conservé).
