-- Weekly statistics report by email, per website. Weekday 0 = Sunday … 6 = Saturday, time in server time.
CREATE TABLE site_reports (
    site_id INT UNSIGNED NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 0,
    recipients VARCHAR(1000) NOT NULL DEFAULT '',
    weekday TINYINT UNSIGNED NOT NULL DEFAULT 1,
    hour TINYINT UNSIGNED NOT NULL DEFAULT 8,
    last_sent_at DATETIME NULL,
    PRIMARY KEY (site_id),
    CONSTRAINT fk_report_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
