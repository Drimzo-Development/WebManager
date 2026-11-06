-- HTTP availability checks of the websites (one row per website and minute, kept for 14 days; cleaned up by the worker).
CREATE TABLE site_checks (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    site_id INT UNSIGNED NOT NULL,
    checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ok TINYINT(1) NOT NULL,
    status_code SMALLINT UNSIGNED NULL,
    ms INT UNSIGNED NULL,
    error VARCHAR(160) NULL,
    PRIMARY KEY (id),
    KEY idx_checks_site (site_id, checked_at),
    KEY idx_checks_time (checked_at),
    CONSTRAINT fk_checks_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
