-- Custom appearance: logo of the dashboard (name and accent colour are stored in the settings table)
CREATE TABLE brand_assets (
    k VARCHAR(40) NOT NULL,
    mime VARCHAR(60) NOT NULL,
    data MEDIUMBLOB NOT NULL,
    etag CHAR(16) NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
