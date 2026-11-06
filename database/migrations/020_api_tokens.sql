-- API tokens for /api/v1. Only the SHA-256 hash of the secret is stored (the token itself is shown once).
-- role limits the token upwards: the lower role of token and user always applies.
CREATE TABLE api_tokens (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    name VARCHAR(80) NOT NULL,
    prefix CHAR(8) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    role ENUM('viewer','operator','admin') NOT NULL DEFAULT 'viewer',
    ip_allow VARCHAR(500) NOT NULL DEFAULT '',
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME NULL,
    last_used_ip VARCHAR(45) NULL,
    revoked_at DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_token_prefix (prefix),
    KEY idx_token_user (user_id),
    CONSTRAINT fk_token_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
