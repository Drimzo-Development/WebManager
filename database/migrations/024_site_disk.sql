-- Disk space used by a website, one value per day (sampled by the worker, kept for 90 days).
CREATE TABLE site_disk (
    site_id INT UNSIGNED NOT NULL,
    day DATE NOT NULL,
    bytes BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (site_id, day),
    CONSTRAINT fk_disk_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
