-- Optional password protection in front of a website (enforced by the reverse proxy)
ALTER TABLE sites
    ADD COLUMN gate_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER webserver_conf,
    ADD COLUMN gate_hash VARCHAR(255) NULL AFTER gate_enabled,
    ADD COLUMN gate_ttl_minutes INT UNSIGNED NOT NULL DEFAULT 480 AFTER gate_hash;
