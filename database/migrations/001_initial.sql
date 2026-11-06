-- WebManager: initial schema

CREATE TABLE users (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    email VARCHAR(190) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The id doubles as the numeric site number (site-001, uid 20001, network wm-net-001, ...).
CREATE TABLE sites (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    type ENUM('static','php','node','express','next','custom') NOT NULL,
    runtime VARCHAR(50) NOT NULL,
    internal_port INT UNSIGNED NOT NULL DEFAULT 3000,
    docroot VARCHAR(100) NOT NULL DEFAULT '',
    memory_mb INT UNSIGNED NOT NULL DEFAULT 512,
    cpus DECIMAL(4,2) NOT NULL DEFAULT 1.00,
    pids INT UNSIGNED NOT NULL DEFAULT 256,
    start_command VARCHAR(1000) NOT NULL DEFAULT '',
    install_command VARCHAR(1000) NOT NULL DEFAULT '',
    build_command VARCHAR(1000) NOT NULL DEFAULT '',
    git_url VARCHAR(500) NOT NULL DEFAULT '',
    git_branch VARCHAR(100) NOT NULL DEFAULT '',
    autostart TINYINT(1) NOT NULL DEFAULT 1,
    desired_state ENUM('running','stopped') NOT NULL DEFAULT 'stopped',
    lifecycle ENUM('creating','ready','deleting') NOT NULL DEFAULT 'creating',
    created_by INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_sites_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Values are AES-256-GCM encrypted with APP_KEY.
CREATE TABLE site_env (
    site_id INT UNSIGNED NOT NULL,
    name VARCHAR(128) NOT NULL,
    value_enc TEXT NOT NULL,
    PRIMARY KEY (site_id, name),
    CONSTRAINT fk_env_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE site_domains (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    site_id INT UNSIGNED NOT NULL,
    domain VARCHAR(253) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_domain (domain),
    KEY idx_domain_site (site_id),
    CONSTRAINT fk_domain_site FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Certificate bookkeeping. 'name' is site-NNN or dashboard. Only a verified TLS check sets status=verified.
CREATE TABLE certificates (
    name VARCHAR(30) NOT NULL,
    site_id INT UNSIGNED NULL,
    status ENUM('none','issued','verified','failed') NOT NULL DEFAULT 'none',
    not_after DATETIME NULL,
    last_error TEXT NULL,
    last_checked_at DATETIME NULL,
    verified_at DATETIME NULL,
    PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE jobs (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    type VARCHAR(50) NOT NULL,
    site_id INT UNSIGNED NULL,
    payload JSON NULL,
    status ENUM('queued','running','succeeded','failed','cancelling','cancelled') NOT NULL DEFAULT 'queued',
    title VARCHAR(200) NOT NULL DEFAULT '',
    exit_code INT NULL,
    error VARCHAR(1000) NULL,
    created_by INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    PRIMARY KEY (id),
    KEY idx_jobs_status (status, id),
    KEY idx_jobs_site (site_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE job_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    job_id INT UNSIGNED NOT NULL,
    line VARCHAR(8192) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_logs_job (job_id, id),
    CONSTRAINT fk_logs_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NULL,
    actor VARCHAR(190) NOT NULL DEFAULT '',
    action VARCHAR(80) NOT NULL,
    target VARCHAR(190) NOT NULL DEFAULT '',
    ip VARCHAR(45) NOT NULL DEFAULT '',
    details JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE login_attempts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    ip VARCHAR(45) NOT NULL,
    email VARCHAR(190) NOT NULL DEFAULT '',
    success TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_attempts_ip (ip, created_at),
    KEY idx_attempts_email (email, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settings (
    k VARCHAR(80) NOT NULL,
    v TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
