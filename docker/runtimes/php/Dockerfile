# Approved PHP runtime for managed websites: PHP-FPM + Nginx in one unprivileged container.
# The nginx configuration is generated per site and mounted at /etc/site/nginx.conf.
# Built by the agent (or install.sh) from this trusted file only; users cannot supply Dockerfiles.
# PHP_IMAGE is set per runtime in templates/runtimes.json (buildArgs)
ARG PHP_IMAGE=php:8.3.36-fpm-alpine3.24
FROM ${PHP_IMAGE}

# Composer from the official, version-pinned image; Node/npm for Vite/Mix builds; git+unzip for Composer
COPY --from=composer:2.10.3 /usr/bin/composer /usr/local/bin/composer

RUN apk upgrade --no-cache && apk add --no-cache nginx icu-libs libzip libpng libjpeg-turbo freetype nodejs npm git unzip \
 && apk add --no-cache --virtual .build-deps $PHPIZE_DEPS icu-dev libzip-dev libpng-dev libjpeg-turbo-dev freetype-dev \
 && docker-php-ext-configure gd --with-freetype --with-jpeg \
 && docker-php-ext-install -j"$(nproc)" pdo_mysql mysqli gd zip intl bcmath exif $(php -r 'echo PHP_VERSION_ID < 80500 ? "opcache" : "";') \
 && apk del .build-deps \
 && rm -rf /etc/nginx/http.d /etc/nginx/conf.d /tmp/* /var/cache/apk/*

COPY php.ini /usr/local/etc/php/conf.d/zz-site.ini
COPY php-fpm.conf /etc/php-fpm.conf
COPY run.sh /usr/local/bin/run.sh
RUN chmod 0755 /usr/local/bin/run.sh

WORKDIR /var/www/site
ENV NGINX_CONF=/etc/site/nginx.conf
EXPOSE 8080
CMD ["/usr/local/bin/run.sh"]
