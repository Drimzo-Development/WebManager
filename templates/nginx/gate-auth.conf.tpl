    # Password protection: the dashboard checks the signed session cookie for every request
    location = /__wm_gate/auth {
        internal;
        set $wm_gate http://{{GATE_UPSTREAM}};
        proxy_pass $wm_gate/gate/auth;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $wm_forwarded_proto;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-WebManager-Site {{GATE_SITE}};
    }
    location @wm_gate_login {
        set $wm_gate http://{{GATE_UPSTREAM}};
        proxy_pass $wm_gate/gate/login;
        proxy_method GET;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $wm_forwarded_proto;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-WebManager-Site {{GATE_SITE}};
        proxy_set_header X-WebManager-Orig-URI $request_uri;
    }
