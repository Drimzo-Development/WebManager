-- Passkeys (WebAuthn) as second factor. The public key is stored as COSE key (CBOR); the credential id is unique across all users.
CREATE TABLE user_passkeys (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    credential_id VARBINARY(1023) NOT NULL,
    public_key BLOB NOT NULL,
    alg INT NOT NULL,
    sign_count INT UNSIGNED NOT NULL DEFAULT 0,
    name VARCHAR(100) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_passkey_cred (credential_id(255)),
    KEY idx_passkey_user (user_id),
    CONSTRAINT fk_passkey_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
