    # WebManager: gate assets (login page, widget), served by the dashboard
    location ^~ /__wm_gate/ {
        set $wm_gate http://{{GATE_UPSTREAM}};
        rewrite ^/__wm_gate/(.*)$ /gate/$1 break;
        proxy_pass $wm_gate;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $wm_forwarded_proto;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-WebManager-Site {{GATE_SITE}};
        client_max_body_size 16k;
    }
    location @wm_maint {
        set $wm_gate http://{{GATE_UPSTREAM}};
        proxy_pass $wm_gate/gate/maintenance;
        proxy_method GET;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $wm_forwarded_proto;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-WebManager-Site {{GATE_SITE}};
    }
