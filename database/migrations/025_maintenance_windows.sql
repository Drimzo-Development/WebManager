-- Maintenance windows: while one is active, notifications about the website (or about everything) are muted.
-- Times are UTC. A repeating window starts at starts_at and recurs every day or week with the same length.
CREATE TABLE maintenance_windows (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    site_id INT UNSIGNED NULL,
    title VARCHAR(80) NOT NULL,
    starts_at DATETIME NOT NULL,
    ends_at DATETIME NOT NULL,
    repeat_every ENUM('none','daily','weekly') NOT NULL DEFAULT 'none',
    created_by INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_mw_site (site_id),
    CONSTRAINT fk_mw_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
