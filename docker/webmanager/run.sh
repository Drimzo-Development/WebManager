#!/bin/sh
# Runs php-fpm and nginx side by side; if either dies the container exits so Docker restarts it.
set -eu
mkdir -p /tmp/nginx/client /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi /tmp/sessions
chmod 0700 /tmp/sessions

php-fpm -F -y /etc/php-fpm.conf &
FPM=$!
nginx -e stderr -c /etc/nginx/nginx.conf -g 'daemon off;' &
NGX=$!

stop() { kill "$FPM" "$NGX" 2>/dev/null || true; wait; exit 0; }
trap stop TERM INT

while kill -0 "$FPM" 2>/dev/null && kill -0 "$NGX" 2>/dev/null; do
  sleep 1
done
echo "php-fpm or nginx exited; stopping container" >&2
kill "$FPM" "$NGX" 2>/dev/null || true
exit 1
