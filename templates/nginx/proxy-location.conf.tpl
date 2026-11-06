    location {{MATCH}} {
        # Variable + resolver: nginx resolves the container at request time, so a stopped
        # site yields 502 instead of making the whole configuration invalid.
        set $wm_upstream http://{{UPSTREAM}};
        proxy_pass $wm_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $wm_forwarded_proto;
        proxy_set_header X-Forwarded-Host $wm_forwarded_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_connect_timeout 10s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        client_max_body_size 128m;
{{EXTRA}}    }
