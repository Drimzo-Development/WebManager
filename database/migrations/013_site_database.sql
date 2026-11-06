-- Optional database container per website (nothing is created until an operator switches it on)
ALTER TABLE sites
    ADD COLUMN db_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER waf_exempt,
    ADD COLUMN db_engine ENUM('mariadb','postgres') NULL AFTER db_enabled,
    ADD COLUMN db_name VARCHAR(32) NULL AFTER db_engine,
    ADD COLUMN db_user VARCHAR(32) NULL AFTER db_name,
    ADD COLUMN db_password_enc TEXT NULL AFTER db_user,
    ADD COLUMN db_root_enc TEXT NULL AFTER db_password_enc,
    ADD COLUMN db_memory_mb INT UNSIGNED NOT NULL DEFAULT 512 AFTER db_root_enc;
