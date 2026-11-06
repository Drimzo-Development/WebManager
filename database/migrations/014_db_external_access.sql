-- Optional access to a website database from outside (allowlisted addresses only; off by default)
ALTER TABLE sites
    ADD COLUMN db_external TINYINT(1) NOT NULL DEFAULT 0 AFTER db_memory_mb,
    ADD COLUMN db_external_allow TEXT NULL AFTER db_external;
