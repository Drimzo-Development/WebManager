-- Per-website IP allow/deny lists and request rate limit (enforced by the reverse proxy)
ALTER TABLE sites
    ADD COLUMN ip_allow TEXT NULL AFTER maintenance_allow_ips,
    ADD COLUMN ip_deny TEXT NULL AFTER ip_allow,
    ADD COLUMN rate_limit_rps INT UNSIGNED NOT NULL DEFAULT 0 AFTER ip_deny,
    ADD COLUMN rate_limit_burst INT UNSIGNED NOT NULL DEFAULT 50 AFTER rate_limit_rps;
