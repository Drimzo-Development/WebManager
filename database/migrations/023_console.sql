-- Web console: switch per website (off until an administrator switches it on), and the hand-over of console tickets from the dashboard to the worker
-- (only used with CONSOLE_TICKETS=worker: the dashboard then cannot ask the agent for a ticket itself).
ALTER TABLE sites ADD COLUMN console_enabled TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE console_requests (
    id CHAR(32) NOT NULL,
    user_id INT UNSIGNED NOT NULL,
    site_id INT UNSIGNED NOT NULL,
    actor VARCHAR(190) NOT NULL DEFAULT '',
    term_cols SMALLINT UNSIGNED NOT NULL DEFAULT 80,
    term_rows SMALLINT UNSIGNED NOT NULL DEFAULT 24,
    ticket CHAR(64) NULL,
    error VARCHAR(300) NULL,
    created_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    KEY idx_console_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
