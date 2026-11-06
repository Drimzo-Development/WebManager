# Managed by WebManager ({{NAME}}). Do not edit: changes are overwritten.
server {
    listen 80;
    server_name {{SERVER_NAMES}};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type text/plain;
    }
{{HTTP_BODY}}
}
{{TLS_SERVER}}
