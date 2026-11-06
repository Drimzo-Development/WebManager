-- Optional credentials for private Git repositories (token is AES-256-GCM encrypted with APP_KEY)
ALTER TABLE sites
    ADD COLUMN git_username VARCHAR(100) NOT NULL DEFAULT '' AFTER git_branch,
    ADD COLUMN git_token_enc TEXT NULL AFTER git_username;
