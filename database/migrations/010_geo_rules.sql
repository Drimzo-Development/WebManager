-- Country rules per website (block listed countries, or allow only listed countries)
ALTER TABLE sites
    ADD COLUMN geo_mode ENUM('off','block','allow') NOT NULL DEFAULT 'off' AFTER rate_limit_burst,
    ADD COLUMN geo_countries TEXT NULL AFTER geo_mode;
