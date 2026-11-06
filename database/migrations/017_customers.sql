-- Customer accounts: a "customer" only sees the websites assigned to them, either read-only ("view") or with day-to-day
-- management ("edit": files, database, commands, cron jobs, environment, maintenance mode, start/stop). Everything else is denied.
ALTER TABLE users MODIFY COLUMN role ENUM('admin','operator','viewer','customer') NOT NULL DEFAULT 'viewer';

CREATE TABLE site_access (
    user_id INT UNSIGNED NOT NULL,
    site_id INT UNSIGNED NOT NULL,
    level ENUM('view','edit') NOT NULL DEFAULT 'view',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, site_id),
    KEY idx_access_site (site_id),
    CONSTRAINT fk_access_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_access_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
