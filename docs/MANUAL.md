# WebManager – Manual

> Detailed documentation. For a short overview, installation and the license see the [README](../README.md).

WebManager is a Docker-based hosting control panel for Debian 13, Debian 12 and Ubuntu 24.04 LTS. One central PHP dashboard
manages any number of websites, each running in its own **hardened container** (static, PHP-FPM, Node.js, Express, Next.js, approved custom templates).

## Contents

1. [Installation](#installation)
2. [Architecture](#architecture)
3. [Using the dashboard](#using-the-dashboard)
4. [Access, maintenance and notifications](#access-maintenance-and-notifications)
5. [HTTPS and domains](#https-and-domains)
6. [Roles](#roles)
7. [API and API tokens](#api-and-api-tokens)
8. [Custom appearance and languages](#custom-appearance)
9. [Updates and releases](#updates-and-releases)
10. [Backup and restore](#backup-and-restore)
11. [Storage cleanup](#storage-cleanup)
12. [Uninstalling](#uninstalling)
13. [Security](#security)
14. [Tests](#tests)

## Installation

```bash
sudo ./install.sh
```

The installer asks for the email and password of the first administrator. Afterwards the dashboard is reachable at `http://SERVER-IP/`.
**Set up a domain with HTTPS under “System & settings” right away**, before the dashboard is used publicly.

Unattended:

```bash
printf '%s' 'AStrongPassword-2026!' > /root/admin.pw && chmod 600 /root/admin.pw
sudo ./install.sh --yes --domain panel.example.com --admin-email admin@example.com --admin-password-file /root/admin.pw
```

All options: `./install.sh --help`.

### Installing from a downloaded file (with verification)

A release consists of `webmanager-<version>.tar.gz`, `….sha256` and `….asc` (detached GPG signature, created by the release workflow).

```bash
# 1. Download archive and checksum
curl -fsSLO https://github.com/Drimzo-Development/WebManager/releases/download/0.1.1/webmanager-0.1.1.tar.gz
curl -fsSLO https://github.com/Drimzo-Development/WebManager/releases/download/0.1.1/webmanager-0.1.1.tar.gz.sha256
curl -fsSLO https://github.com/Drimzo-Development/WebManager/releases/download/0.1.1/webmanager-0.1.1.tar.gz.asc

# 2. Check integrity
sha256sum -c webmanager-0.1.1.tar.gz.sha256

# 3. Check authenticity (releases are signed; key fingerprint 06965753 7E9E022F2772 0408A3052C73 D13AFAF5)
curl -fsSL https://raw.githubusercontent.com/Drimzo-Development/WebManager/main/keys/release.asc | gpg --import
gpg --fingerprint hello@drimzo.cc
gpg --verify webmanager-0.1.1.tar.gz.asc webmanager-0.1.1.tar.gz

# 4. Extract and install
tar -xzf webmanager-0.1.1.tar.gz && cd webmanager-0.1.1 && sudo ./install.sh
```

If only `install.sh` was downloaded, it fetches the archive itself and **aborts if the SHA-256 sum does not match**:
`sudo ./install.sh --release-url https://…/webmanager-0.1.1.tar.gz --sha256 <sum>` (optionally `--sig-url … --keyring release.gpg`).

### What the installer does

`set -Eeuo pipefail`, error trap, log in `/var/log/webmanager/` (mode 0600):

1. detects OS/version, architecture, RAM, disk space and used ports;
2. keeps an existing Docker or installs Docker CE + Compose v2 from the official repository (key fingerprint is verified);
3. creates directories and copies the application to `/opt/webmanager`;
4. creates `.env` (mode 0600) with random secrets (never on screen or in the log);
5. builds the images (or pulls them with `--registry`), runs migrations, starts the stack;
6. checks the health of all components **and** the path through the reverse proxy;
7. creates the first administrator (password via stdin, never as an argument);
8. prints a summary. Exit codes: `1` error, `2` platform/resources, `3` Docker, `4` health check.

Running it again is safe: `.env` secrets, database, websites and certificates stay unchanged; changed configuration files are saved to
`/var/backups/webmanager/config-before-*` first. There are **no** automatic firewall changes (only opt-in `--configure-ufw`).

Directories:

```
/opt/webmanager/          application, docker-compose.yml, .env (0600), scripts
/var/lib/webmanager/
├── sites/site-001/{files,logs,config}   website data (persistent)
├── backups/  database-backups/          backups
├── letsencrypt/                         certificates (0700)
├── runtime/{proxy/conf.d,acme}          generated proxy configuration
└── trash/                               deleted websites (not removed automatically)
/var/log/webmanager/      installation/backup logs, agent audit log
```

Helper command on the server: `sudo /opt/webmanager/scripts/webmanager status|logs|admin:create|admin:reset-password|reconcile`.

## Architecture

```
Internet ──80/443──► proxy (nginx) ──frontend──► webmanager (PHP-FPM + nginx, unprivileged)
                        │                           │  │
                        │ one network per           │  └─ mgmt ─► agent (the only Docker socket access)
                        │ website                   │                ▲
                        ▼ wm-net-NNN                └─ db ─► mariadb └─ mgmt ── worker (job queue, no Docker access)
                  wm-site-NNN (nginx/php | node | …)
```

| Service | Purpose | Notes |
|---|---|---|
| `proxy` | Ports 80/443, routing, TLS | domain→container via Docker DNS at request time; a faulty configuration is rejected by `nginx -t` and rolled back |
| `webmanager` | dashboard (PHP 8.5) | read-only root FS, `cap_drop ALL`, no Docker socket, no access to website files |
| `agent` | validated Docker actions | two tokens: *dashboard* (read, file manager) and *worker* (everything); audit log, rate limit for failed attempts |
| `worker` | longer tasks | queue in MariaDB, live logs by polling, cancellation, daily certificate check |
| `db` | MariaDB 11.4 | only in the internal network `wm-db` |

There is deliberately **no Redis**: the queue lives transactionally in MariaDB (`FOR UPDATE SKIP LOCKED`).

### Website containers

Every website gets a container `wm-site-NNN`, a network `wm-net-NNN` (own /27), its own UID `20000+NNN` and this hardening:
`--cap-drop ALL`, `no-new-privileges`, `--read-only` (+ tmpfs `/tmp`), memory/CPU/PID limits, log rotation, health check,
image only from the allowlist `templates/runtimes.json` (fixed version tags, optional digest). There are no custom Dockerfiles;
the PHP image is built from the shipped, trusted `docker/runtimes/php/Dockerfile`. All websites may use the same internal port.

## Using the dashboard

The dashboard is a single-page app (Preact + TypeScript, source in `frontend/`, build output in `public/assets/app/`).
Anything below is available in the browser – no `docker run/build/compose` needed:

* create websites (type, domain, runtime, port, limits, commands, env, Git), start/stop/restart/delete, “update container”;
* file manager (editor, upload, download, rename, move, copy, delete), logs (container, access, error), CPU/RAM/processes;
* environment variables (stored encrypted), domains, DNS check, certificates, task history with live output and cancellation, audit log;
* **System & settings**: overview, updates, backups, storage, sign-in & 2FA, attack protection, dashboard address, appearance, email notifications.

**Loading code** (tab *Commands → Load code*): **Git** (GitHub, Gitea, GitLab or any https server, optionally with user name + access token for private repositories, stored encrypted) or **archive** (`.zip`, `.tar.gz`, `.tgz` up to 128 MB). Both run in a throw-away container without privileges.

**File manager** (*Content → Files*): browse, create files and folders, upload (button or drag & drop, up to 128 MB per file), rename, copy, delete, download, and a text editor for files up to 2 MB (Ctrl+S saves). **Several files at once:** tick the boxes (Shift selects a range, the box in the header selects everything) and use the bar that appears: *Download as ZIP* (up to 100 items, streamed, nothing is stored), *Compress to ZIP* (writes the archive next to the files as a task of its own, after checking the free disk space; up to 20,000 entries and 2 GB), *Move* to another folder and *Delete*. Links and special files are left out of an archive (the message says how many); folders are packed with their content and permissions. Access is limited to the project directory of the website.

**Laravel** is an application type of its own: PHP 8.3 runtime with Composer and Node/npm, document root `public`, preset commands (`composer install`, `npm ci && npm run build`) and quick commands (`php artisan migrate --force`, `storage:link`, `optimize`, `optimize:clear`). Not included: queue worker and scheduler (use cron jobs).

**Progress display**: buttons that start an operation show an estimated percentage with elapsed time and a fill bar; loading states show skeleton placeholders.

## Access, maintenance and notifications

**Password protection** (*Network & access → Password protection*): visitors see a sign-in page before the website is served. The proxy asks the dashboard per request (`auth_request`); the sign-in is a signed cookie bound to the password (HttpOnly, SameSite=Lax, Secure under HTTPS) with a fixed lifetime. Up to 10 passwords with labels, public paths (e.g. `/api/`, `/webhook`), own sign-in page (title, text, logo), throttling per IP and website (8 in 15 minutes). A small “powered by webmanager” badge is shown; clicking it shows the remaining session time.

**Cron jobs** (*Website → Cron jobs*, operator and higher): commands at fixed times (`minute hour day month weekday` with `*`, lists, ranges, steps, `@hourly`, `@daily`, `@weekly`, `@monthly`) in server time (`TZ` in `.env`). The worker checks every 30 seconds, creates a **task** per run (log kept 60 days) and runs the command in a throw-away container of the website. A cron job never starts twice in parallel; missed runs are not made up; up to 20 per website.

**Error pages**: when a website is down the proxy shows a styled page in the design of WebManager (404 “Page not found”, 502 “This website is currently offline”, 503, 504, 500, 400, 403, 413, 429), headed by the logo of WebManager. The dashboard itself shows its own page with your name and logo, also for files that are missing under `/assets/`. 502/503/504 reload every 20 seconds. They are static files in the proxy image (`docker/proxy/errors/`, generated with `node scripts/build-error-pages.js`) and load no scripts or foreign resources. Answers sent by the website itself are not replaced.

**Maintenance mode**: visitors get a notice page with HTTP 503 (`Retry-After`) while the website keeps running; optionally some IP addresses see the normal website.

**Maintenance windows** (*Hosting → Maintenance*, operator and higher): planned times in which notifications are muted, once or repeating every day or week (up to 14 days long, up to 200 windows). A window applies to one website or, without a website, to everything. Muted: outage, memory, restart and disk messages and failed tasks of that website; for a window without website also certificate, backup, update and ban-wave messages. Not muted: the test notification, and the website itself is not touched (use *Maintenance mode* above to show visitors a notice). A website that is still down when the window ends is reported at the next check; one that recovers during the window produces no “running again” message. Times are entered in your local time and stored as UTC; a repeating window keeps its UTC time, so it shifts by an hour when summer time changes. Creating and deleting windows is written to the audit log.

**Duplicate website**: copy with settings, optionally files and environment variables – without domain, password protection and maintenance mode (e.g. for staging).

**Web server configuration** (nginx, static/PHP only): own `nginx.conf`; before applying, `nginx -t` runs in a throw-away container without network.

**Access rules**: allow or block IP addresses/networks (IPv4/IPv6, CIDR) per website and limit requests per visitor IP (requests per second + burst; answer 429); **country rules** based on the public allocation lists of the five regional registries (loaded on demand, then weekly). Behind a CDN IP and country rules are ineffective.

**Attack protection** (*System & settings → Attack protection*, optional): addresses that send extremely many or almost only erroneous requests are banned automatically for a configurable time (HTTP 444); exceptions (“never block”), permanent bans and a list of current bans with *Unblock*. Per website, requests per second and concurrent connections per IP can be limited. **This does not replace DDoS protection at network level.**

**Two-factor sign-in** (*My account*): authenticator app (RFC 6238) by QR code, 10 one-time recovery codes. **Passkeys** (WebAuthn) as second factor or for **passwordless sign-in** (“Sign in with passkey”, device must require fingerprint, face or PIN). Requirements: dashboard domain with HTTPS; passkeys are bound to the domain. Behind a TLS-terminating proxy (Pangolin, Traefik, Cloudflare …) set the *Public address (for passkeys)* under *System & settings → Dashboard address*. Administrators can reset all second factors of a user.

**Visitor address behind another reverse proxy.** Behind Pangolin, Traefik, Cloudflare … WebManager only sees the address of that proxy: login throttling, automatic bans, rate limits and statistics then treat all visitors as one (ten failed sign-ins lock everybody out). Set `TRUSTED_PROXIES` in `/opt/webmanager/.env` to the addresses of your proxy (comma separated IPs or CIDR ranges, e.g. `172.18.0.0/16`) and restart the stack (`docker compose up -d`). The visitor address is then taken from `X-Forwarded-For`, but only for requests that come from these addresses. List only proxies you control, `0.0.0.0/0` is refused. Without a proxy in front leave it empty.

**Security headers and WAF** (*Network & access → Security & WAF*): per website HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy and optionally a Content-Security-Policy (also report-only), with presets “Recommended” and “Strict”. The WAF is a pattern firewall in the proxy (SQL injection, XSS, path traversal, command injection, scanner user agents, probes for sensitive files). It checks URL, query string and user agent, **not** the request body; modes *off*, *detect only*, *block* (403) and exempt paths. Start with “detect only”.

**Statistics** (*Operations → Statistics*): history charts for CPU, memory, requests (by status code), data volume and visitors per day, top pages, most frequent 404s and WAF hits – 1 hour to 30 days, no tracking scripts. IP addresses are not stored; visitors are counted with short-lived, non-reversible identifiers (deleted after 2 days). Data is kept 35 days under `<DATA_DIR>/metrics`.

**Weekly report** (*Operations → Weekly report*): one or more email addresses (up to 10) receive a weekly summary: total, average and peak requests per minute, visitors, traffic, error rate, firewall hits, CPU/memory and most visited pages, each compared to the previous week.

**Database per website** (*Content → Database*, **optional – never created automatically**): MariaDB 11.4 or PostgreSQL 17 as own container, reachable only inside the private network of the website. The credentials arrive in the website as environment variables (`DB_CONNECTION`, `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `DATABASE_URL`). Start/stop, memory, renew password, create/download/restore dumps, delete permanently. **Manage (Adminer)** opens a database administration in a new tab (only for signed-in operators and administrators, switches off after 30 minutes). **External access** (off by default) opens a port (33000 + website number) only for a list of allowed addresses – unencrypted, use only in a LAN/VPN or through an SSH tunnel.

**Notifications** (*System & settings → Notifications*): channels are **email** (SMTP), **webhook**, **ntfy** and **Telegram**; every channel that is set up receives every message, a channel that fails does not stop the others, and *Send test notification* tests all of them. The worker checks every minute whether websites are running **and answer HTTP requests** (see *Availability*) and reports an outage (after 2 failed checks) and recovery; certificates are reported from a configurable remaining lifetime; failed tasks, failed/overdue backups, low disk space and a **wave of automatic bans** (a configurable number of addresses banned by the flood protection within 15 minutes, at most one message per hour) are reported too. After every successful sign-in the signed-in person gets an email with time, IP address and device. Emails are HTML in the design of the dashboard with a plain-text alternative. SMTP password, webhook address and secret, ntfy topic and token and the Telegram bot token are stored encrypted and never shown again.

* **Webhook:** HTTPS POST with a JSON body (`kind`, `title`, `message`, `facts`, `time`, plus `text` and `content` for Slack/Mattermost/Discord). An optional secret signs the body: header `X-WebManager-Signature: sha256=<HMAC-SHA256 of the body>`.
* **ntfy:** address with topic (`https://ntfy.sh/<topic>` or your own server), optional access token. The topic works like a password. Priority follows the severity (outage and failures: high).
* **Telegram:** bot token (from @BotFather) and chat (number or `@channel`). Messages are plain text.
* Webhook and ntfy addresses must use **https**, a full domain name and no credentials; addresses that point into the server itself (loopback, link-local, cloud metadata) are refused when saving and again when connecting.

**Availability** (*website → Overview → Availability*, list of websites): every minute the agent requests `/` of each running website from the proxy's network (like the proxy does) and records the result (14 days kept): answers below HTTP 500 count as available, 5xx, refused connections and timeouts as failed. The overview shows the share of successful checks (24 hours, 7 and 14 days), a bar chart of the last 24 hours, the response time and the latest failed checks. A website whose container runs but does not answer is reported as an outage by the notifications, too. Websites that are stopped on purpose are not checked.

**Resources** (*website → Overview → Resources*): memory, CPU and processes against the limits of the website, the restart counter (with a flag when the last stop was caused by memory exhaustion) and the disk space of the last 30 days – files, logs and database, measured once a day and kept for 90 days. Notifications (*System & settings → Notifications*): memory above a share of the limit for 5 minutes, a restart after the memory limit was exceeded (at most once an hour per website) and, if you set a size, a website that grows beyond it (at most once a week). Limits are changed under *Settings*.

**Application templates** (*New website → Start from*): *WordPress*, *Joomla*, *Nextcloud*, *Matomo*, *Grav* (PHP) and *Uptime Kuma* are available. *Uptime Kuma* runs the official image in a pinned version (`runtimes.json`, nothing is downloaded at setup); its data lives in the `data` folder of the website, and the first visitor creates the administrator account. For example *WordPress* creates a PHP website with its own MariaDB database, downloads WordPress from wordpress.org (verified with the published SHA-1 checksum) and writes a `wp-config.php` with fresh keys that reads the database settings from the environment of the container – so the database password is not stored in a file and a password rotation keeps working. Afterwards open the website and finish the installation in the browser. Templates are listed in `templates/apps.json`; their steps are fixed code in `workers/src/apps.js` (downloads only from the vendor over https, checksum verified).

**Web console** (*website → Console*, **administrators only**): an interactive shell (bash, otherwise sh) inside the running container of the website, with the rights of the website itself – useful for `php artisan`, `npm`, looking at files or processes. Safe by default:
* **Off per website** until an administrator switches it on in the Console tab (*Allow the console for this website*); switching it off ends the open sessions of that website at once.
* Needs an account with **two-factor authentication** (authenticator app or passkey) and asks for the **password again** (plus the authenticator code) before a session opens; the confirmation is valid for 10 minutes and failed attempts are throttled.
* A session ends with *Disconnect*, when the shell exits, after 15 minutes without input, after 2 hours, **when the account signs out, changes its password, is deactivated, demoted or deleted**, or when an administrator ends it (*Open sessions* list under the terminal). At most 3 consoles per website and 6 in total.
* Only the worker hands out console tickets by default, so a compromised dashboard cannot open shells; `CONSOLE_TICKETS=dashboard` in `.env` lets the dashboard do it (about a second faster). `CONSOLE=off` removes the feature completely. After changing `.env` run `docker compose up -d`.
* The terminal runs in its own page (*Open in new window* works too) and needs WebSockets: a reverse proxy in front of WebManager (Cloudflare, Traefik, Pangolin …) must pass them on. The one-time ticket is sent as WebSocket subprotocol, never in the address.
* Only opening, closing, confirmations and who ended a session are logged (audit log and agent audit log), **never what is typed**. It is not available through API tokens.

**Audit log** (*Audit log*, administrators): who did what and when (sign-ins and failures, users and roles, API tokens, deploys, commands, settings …). Search (all words), period, “Load older entries” and **export as CSV** (up to 20,000 entries of the current search; the export itself is logged). Entries are kept for one year.

## HTTPS and domains

* Several domains per website under *Domains & HTTPS*; “Check DNS” shows the resolution and compares it with the server IPs.
* Let's Encrypt via HTTP-01 (certbot container, pinned). DNS is checked before the request (spares rate limits); failures are diagnosed (NXDOMAIN, port 80 unreachable, wrong server, rate limit).
* The HTTP→HTTPS redirect is only activated once a certificate exists.
* **DNS provider** (*System → DNS provider*, administrators): connects WebManager to **Cloudflare** or **Hetzner** DNS (the zone must be in the new Hetzner Console). The API token is stored encrypted, handed to the agent only by the worker, kept there in a file that only root of the host can read and mounted read-only into the throw-away certificate container; it is never shown again. Cloudflare needs a token with *Zone → Zone → Read* and *Zone → DNS → Edit*, Hetzner a project token with read & write access. *Save and test* checks that the token sees your zones.
* **Wildcard certificates and DNS validation:** enter `*.example.com` as a domain of a website (`example.com` can stay next to it) and issue the certificate – it is validated through DNS (`_acme-challenge` TXT records, set and removed again automatically, then WebManager waits a configurable time for the name servers). Without a wildcard the option *Validate through DNS* does the same for a website that is not reachable yet. Such certificates are renewed daily through DNS as well; if the provider is removed or the token is revoked they can no longer be renewed. A website certificate that already exists is not re-issued only because the method changed: adding a name (such as the wildcard) issues a new one. The dashboard domain cannot be a wildcard.
* **Set DNS records:** a button under *Domains* creates (or corrects) the A/AAAA records of the website's domains with the server addresses from `PUBLIC_IPS` in `.env`. Other records are not touched, a record is only replaced when it points elsewhere, and Cloudflare records are created without the proxy (grey cloud).
* **The dashboard reports “HTTPS verified” only after a real TLS check**: the agent connects to the proxy with SNI and validates chain, host name and expiry.
* Renewal runs daily in the worker; expiry warning (< 21 days) in the dashboard. `ACME_STAGING=true` in `.env` for tests.
* Dashboard domain: *System & settings*. Afterwards the dashboard is reachable **only** through this domain; unknown hosts get 444.

## Roles

Roles: **administrator** (everything), **operator** (manage websites, no user/system settings) and **viewer** (read only, without files, logs and environment variables).

## API and API tokens

Under `/api/v1` there is a stable interface for scripts and automation, described in [`docs/openapi.yaml`](openapi.yaml). It is an **allowlist** (read websites, start/stop/restart containers, follow and cancel tasks). Roles and mandatory 2FA apply exactly as in the dashboard.

Access with a **personal token** (`Authorization: Bearer wmt_…`) created under “API tokens”:

* the token is shown **once**; only its SHA-256 hash is stored;
* it never has more rights than its owner and expires after 365 days at the latest (default 90);
* optionally restricted to IP addresses or CIDR ranges; revoking takes effect immediately;
* tokens only work under `/api/v1`, create no session and cannot create or change tokens;
* 20 invalid tokens from one address block it for 15 minutes.

```bash
curl -H "Authorization: Bearer wmt_…" https://panel.example.com/api/v1/sites
```

### Metrics for Prometheus and Grafana

`GET /api/v1/metrics` returns the state of all websites in the Prometheus text format: container running, restarts and memory kills, CPU, memory (use and limit), processes, disk space, certificate expiry, the result and response time of the latest HTTP check and the availability of the last 24 hours, plus `webmanager_agent_up`. A **viewer** token is enough. A value that is not known (for example no HTTP check in the last 10 minutes) is left out, not reported as 0.

```yaml
scrape_configs:
  - job_name: webmanager
    scheme: https
    metrics_path: /api/v1/metrics
    authorization:
      credentials: wmt_…
    static_configs:
      - targets: ['panel.example.com']
```

Useful alert rules: `webmanager_site_up == 0`, `webmanager_site_container_restarts_total` increasing, `webmanager_site_memory_usage_bytes / webmanager_site_memory_limit_bytes > 0.9`, `webmanager_site_certificate_expiry_timestamp_seconds - time() < 14 * 86400`.

## Custom appearance

Under *System & settings → Appearance* (administrators) the dashboard can be personalised:

* **Name** (1 to 40 characters, default “Drimzo Development”): sidebar, sign-in page, browser title, passkey/authenticator label and emails;
* **Logo** (PNG, JPEG, WebP or SVG up to 512 KB) and **accent colour** (`#RRGGBB`, colours that are too light for white text are rejected);
* **“Reset everything”** restores the defaults.

**The notices “webmanager” and “made with ♥ by Drimzo Development” cannot be removed** (see [NOTICE](../NOTICE.md)): they appear below the name, next to the version, on the sign-in page, on the pages of password-protected websites, in the proxy error pages and on the default page of new websites.

### Languages

The interface is English; further languages are plain JSON files in `lang/` (shipped with the program, e.g. `lang/de.json` for German). A language shows up in the language menu of the sign-in page and under *My account* as soon as its file exists, and is chosen per browser (saved in the browser). **English is the default**: the language of the browser is not used, someone has to choose another language once. Texts without a translation stay English, so a file can be completed step by step. Messages that the server sends (for example validation errors) are not translated yet.

A file maps the English texts of the interface to their translation:

```json
{
    "_meta": { "name": "Deutsch", "locale": "de-DE" },
    "strings": {
        "Save": "Speichern",
        "Delete {name}": "{name} löschen"
    }
}
```

`{name}`-style placeholders must appear in the translation exactly as in the English text. The file name is the language code (`de`, `fr`, `pt-BR`); `locale` is the BCP 47 tag used for dates and numbers. With PHP on the machine you work on:

```bash
php scripts/i18n.php init fr "Français" fr-FR   # new file with every text of the interface (empty = untranslated)
php scripts/i18n.php missing fr                  # what is still untranslated, and entries that are no longer used
php scripts/i18n.php sync fr                     # after the interface changed: add new texts, remove unused ones
php scripts/i18n.php check                       # validate all language files (also done by the tests)
```

Texts that are code, commands or product names can stay as they are (an empty or identical entry is fine).

## Updates and releases

```bash
sudo /opt/webmanager/update.sh --check     # installed and available version
sudo /opt/webmanager/update.sh             # newest release from the update server
sudo /opt/webmanager/update.sh --version 0.1.0
sudo /opt/webmanager/update.sh --file release.tar.gz --sha256 <sum>   # offline
```

**Source:** the update server `https://updates.drimzo.cc/webmanager/stable`. The address is part of the code and cannot be changed. For every version it carries `webmanager-<version>.tar.gz`, `….tar.gz.sha256` and `….tar.gz.asc` (signature) plus a `LATEST` file (e.g. `0.1.0`, no `v`).
The server is only the transport: if the installed version contains `keys/release.asc`, every update must carry a valid signature of that key (the key of the *installed* version is used, never one from the downloaded archive), so a manipulated server cannot deliver a foreign release. `UPDATE_KEYRING` (GPG keyring file in `.env`) can be used instead. Without either only the SHA-256 is checked and a warning is logged. For servers without internet access use the offline update (`--file`).

**Unsupported versions:** the update server may publish the oldest version that is still supported (file `MIN_SUPPORTED`). If the installed version is older, *System & settings → Updates* shows a warning that it receives no further fixes, including security fixes. Nothing is blocked or installed automatically; the notice only asks you to update.

Flow: determine version → backup (configuration + DB dump) → download over https → SHA-256 (and GPG) → save the application state → build images (running services stay active; runtime images like PHP are built **beforehand**) → migrations → switch → health checks. **On any error there is an automatic rollback** (old files, old database state if migrations ran, previous images). Websites, domains, certificates, database and files are not touched.
The update script hands over to the `update.sh` **of the new version** after the download and verification, so fixes in the update flow already apply to the update that delivers them.

**Update from the dashboard:** *System & settings → Updates* (administrators). A notice in the header of all pages announces new versions; the tab shows the changelog (the descriptions of the GitHub releases) and the button **“Update now”**, which starts the same `update.sh` – with backup, SHA-256/GPG check, health check and automatic rollback.

* A **host helper** (systemd) makes this possible: `webmanager-updatecheck.timer` asks the release source **every 2 hours**; `webmanager-update.path` starts `scripts/update-helper.sh apply` as soon as the dashboard writes a request. The containers execute nothing on the host – they only write a file `$DATA_DIR/update/request` with `check` or `update X.Y.Z`, which the helper validates again (version pattern; never a downgrade).
* Switch off: `UPDATE_HELPER=off` in `.env` (and `systemctl disable --now webmanager-update.path webmanager-updatecheck.timer`). Check immediately: `sudo systemctl start webmanager-updatecheck.service`.
* **Roll back to the previous version** (*Updates → Roll back*, on the server: `sudo /opt/webmanager/scripts/rollback.sh [--dry-run]`) reverts the **last update** using the program files (`app-tree-<version>-<time>.tar.gz`), the database dump from right before the update and the images of that version. **The database is reset to the state before the update**; changes since then (task history, audit log, settings, new users) are lost; websites, files, certificates and domains stay untouched. The dashboard asks you to type `ROLL BACK`. On any error the script restores the state from before the roll back.
* **Email on new version:** each new version is reported **once** with the changelog (switch “New version of WebManager available”).
* **Automatic updates (optional, off by default):** *Updates → Automatic updates*. The server checks hourly and installs new **patch versions** (same major.minor line, e.g. 0.1.1 → 0.1.4) inside the configured time window (full hours, server time, default 2–5 am). Feature versions (0.1 → 0.2) are **never** installed automatically. At most one attempt per 20 hours; **after a failure that version is paused** until the setting is saved again; the result arrives by email.

**Publishing a release** (maintainers): push a tag. `git tag 0.1.0 && git push origin 0.1.0` starts `.github/workflows/release.yml`, which checks that the tag matches `VERSION`, runs tests, builds the archive and creates the GitHub release with the matching `CHANGELOG.md` section as notes. See [CONTRIBUTING.md](../CONTRIBUTING.md). Manually: `GITHUB_TOKEN=… scripts/publish-release.sh --notes "…"`.

## Backup and restore

```bash
sudo /opt/webmanager/backup.sh --consistent --passphrase-file /root/backup.pass   # encrypted (gpg AES-256)
sudo /opt/webmanager/backup.sh --db-only
sudo /opt/webmanager/install.sh --enable-backup-timer                             # daily 03:30 (systemd)
```

Content: `.env`/compose/VERSION, a consistent DB dump (`--single-transaction`), website files and configurations, certificates, runtime data, `MANIFEST.json` and `SHA256SUMS`. Archives are written with mode 0600 into a 0700 directory (default `/var/lib/webmanager/backups`; for real protection against disk failure use `--output` on another medium or copy externally). Retention: `--retention-days` (14) and `--keep-last` (3). **The archive contains secrets – encrypt or store it safely.**

### External target, retention and restore test

Connect an external target through **rclone** (SFTP, S3-compatible, Hetzner Storage Box, WebDAV, Backblaze …):

```bash
sudo apt-get install rclone
sudo /opt/webmanager/scripts/backup-remote.sh setup --provider hetzner --user u123456
sudo /opt/webmanager/scripts/backup-remote.sh setup --provider sftp --host backup.example.com --user bk
sudo /opt/webmanager/scripts/backup-remote.sh setup --provider s3 --bucket my-bucket --access-key AKIA...
sudo /opt/webmanager/scripts/backup-remote.sh setup --provider b2 --bucket my-bucket --account 0012345abcde
sudo /opt/webmanager/scripts/backup-remote.sh setup --remote NAME:PATH      # an existing rclone remote
```

Secrets are asked for on the terminal; they never appear on the command line or in the dashboard. `setup` checks the connection and write permission, creates the **backup passphrase** (`/etc/webmanager/backup.pass`, mode 0600) and stores `BACKUP_REMOTE` and `BACKUP_PASSPHRASE_FILE` in `.env`.
**Keep this passphrase outside the server (password manager)** – without it the backups cannot be read after a total failure.

* From then on `backup.sh` encrypts every full backup and uploads it; unencrypted archives are **never** uploaded. After the upload the size on the target is compared.
* **Retention on the target** (grandfather-father-son): newest backup of the last 7 days, 4 weeks and 6 months (`BACKUP_REMOTE_KEEP_DAILY/WEEKLY/MONTHLY`); the newest backup is never deleted.
* **Restore test** (`backup-remote.sh verify [local|remote] [--quick]`, dashboard button, **automatically every Sunday**): downloads the newest backup, decrypts it, checks archive and all checksums and imports the database dump into a **throw-away database** (own container without network). Passed means: tables and at least one user exist after the import. A failed test sends an email.
* **Dashboard:** *System & settings → Backups* shows the last backup, target, count/size, last upload and restore test and has buttons for “Create backup now”, “Upload to external target” and both restore tests.

**Restore on a fresh server**

```bash
sudo ./install.sh --no-admin                       # install the same (or a newer) version
sudo /opt/webmanager/restore.sh /path/webmanager-backup-….tar.gz[.gpg] [--passphrase-file F]
```

`restore.sh` verifies checksums, asks for the word `RESTORE`, backs up the current DB state, renames existing directories to `*.pre-restore-<time>` (nothing is deleted), adopts the `APP_KEY` (needed for encrypted environment variables), restores database, files and certificates and reconciles containers/proxy. DNS of the domains must point to the new server.

**Total failure with an external target:** on the new server run `install.sh --no-admin`, `apt-get install rclone`, put `rclone.conf` and `backup.pass` back, then:

```bash
sudo /opt/webmanager/scripts/backup-remote.sh fetch --remote NAME:PATH
sudo /opt/webmanager/restore.sh --passphrase-file /etc/webmanager/backup.pass /var/lib/webmanager/backups/webmanager-backup-….tar.gz.gpg
```

## Storage cleanup

*System & settings → Storage* (administrators) shows disk usage and what can safely be removed. Before cleaning there is a **preview**; cleaning runs as a task.

| Category | Rule (fixed in the agent, not changeable from the dashboard) |
|---|---|
| Old WebManager images | all versions except the **running and the previous one**; images in use and foreign images never |
| Unnamed image layers | leftovers of builds without an image |
| Build cache | `docker builder prune` |
| Program backups of earlier updates | `app-tree-*.tar.gz`, the **newest 2 stay** |
| Old database dumps | `database-backups/db-*.sql.gz`: the newest 3 and everything younger than 14 days stay |
| Old logs | update/backup/installation logs older than 30 days, the newest 5 of each kind stay; the audit log never |
| Trash | deleted websites **older than 30 days** (after that gone for good) |

Never offered: websites, databases, certificates, full backups, the trash of younger websites.

## Uninstalling

```bash
sudo /opt/webmanager/uninstall.sh        # interactive menu
```

1. *Stop only* – nothing is removed.
2. *Remove application* (recommended) – database volume, website files/containers (stopped), certificates and backups stay; `.env` is saved to `config-retained/`.
3. *Delete everything* – only after a warning and typing exactly `DELETE ALL DATA`; backups only with an extra confirmation (`--purge-backups`).

Only objects of this installation are removed (fixed names / label `drimzo.managed=true`); foreign containers, networks, images and volumes stay untouched. Docker itself is never removed.

## Security

See [docs/SECURITY.md](SECURITY.md) for the threat model, measures and residual risks. In short:

* The Docker socket is mounted **only** in the `agent`; the agent accepts only validated, fixed actions, only on the internal network, with bearer token (constant-time comparison) and audit log.
* The dashboard only has a read/file-manager token and cannot create or start containers.
* File access of websites runs with the UID of the website, with path/symlink checks.
* Dashboard: Argon2id, session hardening, CSRF token, login throttling, strict CSP without inline code, origin check, audit log of all administrative actions.

**Hardening on request:**

* **Mandatory 2FA** (*System & settings → Sign-in & 2FA*): for administrators or everybody. Emergency (authenticator lost, only administrator): `docker compose -f /opt/webmanager/docker-compose.yml exec -T webmanager php bin/console security:require-2fa off`.
* **Break-glass access:** whoever lost the authenticator app, recovery codes or passkeys, or is locked out by failed attempts, gets back in through the server console (requires root/Docker access; logged as `admin.*_cli`). Shortcut: `dc() { docker compose -f /opt/webmanager/docker-compose.yml exec -T webmanager php bin/console "$@"; }`

  | Task | Command |
  |---|---|
  | List accounts, role, 2FA and passkeys | `dc user:list` |
  | Reset the second factor (authenticator, recovery codes **and** passkeys) | `dc user:reset-2fa name@example.com` |
  | … authenticator and codes only, keep passkeys | `dc user:reset-2fa name@example.com --keep-passkeys` |
  | Set a new password (via stdin, never as an argument) | `printf '%s' 'New-Password-123!' \| dc admin:reset-password name@example.com` |
  | Lift lockouts after failed attempts (all, one email or one IP) | `dc login:unlock` / `dc login:unlock name@example.com` / `dc login:unlock 203.0.113.9` |
  | Switch off mandatory 2FA | `dc security:require-2fa off` |
  | Create a new administrator | `printf '%s' 'Password' \| dc admin:create name@example.com` |

* **Egress guard** (`install.sh --harden-egress` or `sudo scripts/egress-guard.sh install`): website containers may no longer reach the Docker host (incl. SSH, dashboard ports) and metadata/link-local addresses; internet, npm and email keep working. `EGRESS_BLOCK_PRIVATE=1` in `.env` additionally blocks private networks. Needs `iptables`.

### Security updates

Everything is version-pinned (no `latest`). Stack images, PHP/static runtimes and the Git and certbot tool images are built from the shipped, trusted Dockerfiles and brought to the current Alpine package level with `apk upgrade` at build time. Agent and worker contain no npm.
Check yourself (Trivy, fixable HIGH/CRITICAL findings only): `scripts/security-scan.sh` (all images of this installation) or `scripts/security-scan.sh drimzo/agent:<version>`.

Known, deliberately accepted leftovers: the official `mariadb` image contains `gosu` with an older Go standard library (it only runs at start to drop privileges); the certbot image reports entries from its development requirement files; the official `node` image brings npm with its own dependencies (your code runs there); **Node.js 20** is out of support – the template stays available but is marked.

Keep the **server operating system and Docker** current through the package manager (WebManager deliberately installs no automation for this):
`sudo apt-get update && sudo apt-get upgrade`. A restart after kernel updates is harmless: all containers use `restart: unless-stopped`.

## Tests

* `agent/` and `workers/`: `npm test`; `frontend/`: `npm run build && npm test`.
* PHP: `for t in tests/*.test.php; do php "$t"; done` (API tokens and OpenAPI consistency, passkey verification against a simulated authenticator, appearance, cron expressions).
* Shell: `tests/*.test.sh` (update helper, GitHub release lookup, release publishing with simulated GitHub, rollback, egress guard, handoff, health checks, external backup with simulated rclone/Docker); `tests/backup-remote-provider.test.sh` needs root.
* `tests/api-v1.e2e.sh`: end-to-end against the real dashboard image and a real MariaDB (needs Docker). `tests/acceptance.js` / `tests/run-acceptance.sh`: end-to-end against a running installation (`ADMIN_EMAIL=… ADMIN_PASSWORD=… tests/run-acceptance.sh 80`).

The code was developed on Windows with Docker Desktop; a real HTTPS issuance (needs a public domain and port 80) and a real server reboot have not been exercised in the automated tests.
