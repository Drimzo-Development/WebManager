-- Maximum simultaneous connections per visitor IP for a website (0 = unlimited)
ALTER TABLE sites ADD COLUMN conn_limit INT UNSIGNED NOT NULL DEFAULT 0 AFTER rate_limit_burst;
