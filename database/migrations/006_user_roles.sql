-- Multiple users with roles: admin (everything), operator (manage websites), viewer (read only)
ALTER TABLE users
    ADD COLUMN name VARCHAR(100) NOT NULL DEFAULT '' AFTER email,
    ADD COLUMN role ENUM('admin','operator','viewer') NOT NULL DEFAULT 'viewer' AFTER password_hash,
    ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1 AFTER role;
-- everybody who existed before roles were introduced keeps full access
UPDATE users SET role = 'admin';
