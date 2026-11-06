# Changelog

All notable changes. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [Semantic Versioning](https://semver.org/). The section of a version is used as the release notes on GitHub
and is shown in the dashboard under *Updates*.

## [Unreleased]

### Changed
- **Node.js 26:** The dashboard, the management agent and the worker now run on Node.js 26 instead of Node.js 24. Websites keep the runtime selected in their settings.

## [0.1.0]

First public release.

### Features
- Hosting control panel on Docker: every website runs in its own hardened container (static, PHP, Laravel, Node.js, Express, Next.js).
- Single-page dashboard (English): websites, file manager, Git/archive deploy, commands, cron jobs, environment variables, statistics, logs, tasks.
- HTTPS with Let's Encrypt, domains, DNS check, automatic renewal.
- Database per website (MariaDB/PostgreSQL) with Adminer access.
- Protection: password protection, IP and country rules, rate limiting, WAF, security headers, automatic bans, maintenance mode.
- Dashboard security: Argon2id, 2FA (TOTP), passkeys (WebAuthn), roles (administrator, operator, viewer), API tokens and `/api/v1`.
- Backups with an external target (rclone), automatic restore test, restore script.
- Updates from the project's own update server (`https://updates.drimzo.cc/webmanager/stable`): checked every 2 hours, SHA-256 and GPG signature verification, backup, health checks, automatic rollback and optional automatic patch updates.
- Custom appearance (name, logo, colour); the notice “made with ♥ by Drimzo Development” stays.
- GitHub Actions: tests on every push and an automatic release when a version tag is pushed.
