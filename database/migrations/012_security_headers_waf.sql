-- Security response headers (JSON) and web application firewall settings per website
ALTER TABLE sites
    ADD COLUMN sec_headers TEXT NULL AFTER geo_countries,
    ADD COLUMN waf_mode ENUM('off','detect','block') NOT NULL DEFAULT 'off' AFTER sec_headers,
    ADD COLUMN waf_categories VARCHAR(120) NOT NULL DEFAULT 'sqli xss traversal rce probe scanner' AFTER waf_mode,
    ADD COLUMN waf_exempt TEXT NULL AFTER waf_categories;
