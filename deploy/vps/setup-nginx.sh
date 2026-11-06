#!/bin/bash
# Uruchom RAZ na VPS jako administrator:  sudo bash /home/deploy/wol-dogeos/deploy/vps/setup-nginx.sh
# Dodaje wpis nginx dla dogeos.waroflords.pl i certyfikat HTTPS (Let's Encrypt). Nie zmienia wpisu produkcyjnego waroflords.pl.
set -e
SRC=/home/deploy/wol-dogeos/deploy/vps/nginx-dogeos.conf
cp "$SRC" /etc/nginx/sites-available/dogeos-waroflords
ln -sf /etc/nginx/sites-available/dogeos-waroflords /etc/nginx/sites-enabled/dogeos-waroflords
nginx -t
systemctl reload nginx
certbot --nginx -d dogeos.waroflords.pl --non-interactive --agree-tos --register-unsafely-without-email --redirect
nginx -t && systemctl reload nginx
echo "Gotowe: https://dogeos.waroflords.pl"
