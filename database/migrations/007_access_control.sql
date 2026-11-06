-- Password gate: several passwords, public paths, custom login page. Maintenance mode.
CREATE TABLE site_gate_passwords (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    site_id INT UNSIGNED NOT NULL,
    label VARCHAR(100) NOT NULL DEFAULT '',
    password_hash VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_gate_pw_site (site_id),
    CONSTRAINT fk_gate_pw_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO site_gate_passwords (site_id, label, password_hash)
    SELECT id, 'Default', gate_hash FROM sites WHERE gate_hash IS NOT NULL AND gate_hash <> '';
UPDATE sites SET gate_hash = NULL;

-- logo shown on the login page (kept apart so that listing websites never loads image data)
CREATE TABLE site_gate_logo (
    site_id INT UNSIGNED NOT NULL,
    mime VARCHAR(40) NOT NULL,
    data MEDIUMBLOB NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (site_id),
    CONSTRAINT fk_gate_logo_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE sites
    ADD COLUMN gate_title VARCHAR(150) NOT NULL DEFAULT '' AFTER gate_ttl_minutes,
    ADD COLUMN gate_text VARCHAR(500) NOT NULL DEFAULT '' AFTER gate_title,
    ADD COLUMN gate_bypass_paths TEXT NULL AFTER gate_text,
    ADD COLUMN maintenance_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER gate_bypass_paths,
    ADD COLUMN maintenance_title VARCHAR(150) NOT NULL DEFAULT '' AFTER maintenance_enabled,
    ADD COLUMN maintenance_message VARCHAR(1000) NOT NULL DEFAULT '' AFTER maintenance_title,
    ADD COLUMN maintenance_allow_ips TEXT NULL AFTER maintenance_message;
