
server {
    listen 443 ssl;
    http2 on;
    server_name {{SERVER_NAMES}};

    ssl_certificate /etc/letsencrypt/live/{{CERT}}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{{CERT}}/privkey.pem;

{{PROXY_LOCATION}}
}
