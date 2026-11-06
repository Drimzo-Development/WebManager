#!/bin/sh
# php-fpm + nginx for one website. If either dies the container exits and Docker restarts it.
set -eu
mkdir -p /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp

php-fpm -F -y /etc/php-fpm.conf &
FPM=$!
nginx -e stderr -c "${NGINX_CONF:-/etc/site/nginx.conf}" -g 'daemon off;' &
NGX=$!

stop() { kill "$FPM" "$NGX" 2>/dev/null || true; wait; exit 0; }
trap stop TERM INT

while kill -0 "$FPM" 2>/dev/null && kill -0 "$NGX" 2>/dev/null; do
  sleep 1
done
echo "php-fpm or nginx exited" >&2
kill "$FPM" "$NGX" 2>/dev/null || true
exit 1
