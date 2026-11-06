# WebManager dashboard: PHP-FPM + Nginx, unprivileged, read-only root filesystem.
# Build context: repository root.

# Stage 1: new frontend (Preact + TypeScript). The output is plain files, Node is not part of the final image.
FROM node:24.22.2-alpine3.24 AS ui
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
# the tests check the language files (frontend/src/i18n.test.ts reads ../../lang)
COPY lang/ /build/lang/
# writes to /build/public/assets/app and /build/public/assets/console (see vite.config.ts, vite.console.config.ts)
RUN npm test && npm run build

FROM php:8.5.12-fpm-alpine3.24

# opcache is compiled into PHP core since 8.5; no separate extension to install
RUN apk upgrade --no-cache && apk add --no-cache nginx \
 && docker-php-ext-install -j"$(nproc)" pdo_mysql \
 && rm -rf /etc/nginx/http.d /etc/nginx/conf.d \
 && php -r 'foreach (["curl","mbstring","openssl","pdo_mysql","sodium"] as $e) { if (!extension_loaded($e)) { exit(1); } }'

COPY docker/webmanager/php.ini /usr/local/etc/php/conf.d/zz-webmanager.ini
COPY docker/webmanager/php-fpm.conf /etc/php-fpm.conf
COPY docker/webmanager/nginx.conf /etc/nginx/nginx.conf
COPY docker/webmanager/run.sh /usr/local/bin/run.sh

WORKDIR /srv/webmanager
COPY app ./app
COPY public ./public
COPY --from=ui /build/public/assets/app ./public/assets/app
COPY --from=ui /build/public/assets/console ./public/assets/console
COPY bin ./bin
COPY database ./database
COPY templates ./templates
COPY lang ./lang
COPY VERSION ./VERSION

RUN chmod 0755 /usr/local/bin/run.sh bin/console \
 && find /srv/webmanager -type d -exec chmod 0755 {} + \
 && find /srv/webmanager -type f -exec chmod 0644 {} + \
 && chmod 0755 bin/console

USER www-data
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["/usr/local/bin/run.sh"]
