-- Scheduled commands (cron jobs) per website. Times are stored in UTC; the worker evaluates the schedule in the server time zone.
CREATE TABLE site_cron (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    site_id INT UNSIGNED NOT NULL,
    name VARCHAR(100) NOT NULL,
    schedule VARCHAR(100) NOT NULL,
    command VARCHAR(1000) NOT NULL,
    timeout_sec INT UNSIGNED NOT NULL DEFAULT 600,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    notify_fail TINYINT(1) NOT NULL DEFAULT 1,
    next_run_at DATETIME NULL,
    last_run_at DATETIME NULL,
    last_status ENUM('ok','failed','skipped') NULL,
    last_exit INT NULL,
    last_job_id INT UNSIGNED NULL,
    last_duration_ms INT UNSIGNED NULL,
    created_by INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_cron_due (enabled, next_run_at),
    KEY idx_cron_site (site_id),
    CONSTRAINT fk_cron_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
