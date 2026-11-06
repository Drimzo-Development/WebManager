-- Two-factor authentication (TOTP) for dashboard users
ALTER TABLE users
    ADD COLUMN totp_secret_enc TEXT NULL AFTER active,
    ADD COLUMN totp_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER totp_secret_enc,
    ADD COLUMN totp_last_step BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER totp_enabled;

-- One-time recovery codes (stored as SHA-256; 80 bits of entropy each, so no slow hash is needed)
CREATE TABLE user_recovery_codes (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    code_hash CHAR(64) NOT NULL,
    used_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_recovery_user (user_id),
    CONSTRAINT fk_recovery_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
