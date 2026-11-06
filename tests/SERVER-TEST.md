# Testing the new features on a test server

Use a server that is not production, with a real domain you control (for DNS and certificates) and `ACME_STAGING=true` in `.env`
(certificates are then not trusted, but Let's Encrypt's rate limits do not apply).

## 1. Put the version on the server

Either build a release archive from this branch and install/update with it, or on a server with a checkout:

```bash
git pull                                  # the branch under test
docker compose build webmanager worker agent
docker compose up -d
docker compose exec -T webmanager php bin/console migrate      # creates maintenance_windows (migration 025)
```

Check that `lang/` is in the dashboard image (`docker compose exec webmanager ls /srv/webmanager/lang`) and that `templates/dns/dns_hook.py`
exists in the install directory (the agent reads it from there).

## 2. Automatic checks

```bash
WM_EMAIL=test-admin@example.com WM_PASSWORD='…' WM_TOKEN=wmt_… tests/server-smoke.sh https://panel.test.example.com
```

`WM_EMAIL`/`WM_PASSWORD` must be an administrator **without** two-factor sign-in (create a test account). `WM_TOKEN` is a viewer token
(*API tokens*). Add `WM_INSECURE=1` for a self-signed certificate. The script checks languages, the metrics format, the templates list, creates
and deletes a maintenance window and checks the DNS provider settings. With `WM_DNS_PROVIDER=cloudflare|hetzner` and `WM_DNS_TOKEN=…` it also
connects the provider (this changes the setting) and waits for the token test.

The unit tests can run without a server: `php tests/<name>.test.php`, `python3 -I tests/dns_hook.test.py`, in `frontend/` and `workers/` and `agent/` `npm test`.

## 3. By hand

### Application templates
*New website → Start from*: create one website each from **Joomla**, **Nextcloud**, **Matomo**, **Grav** (add a domain that points to the server).

| Template | Expect |
|---|---|
| all | the task log shows `Download …`, `sha256sum` output `OK`, then `Files are in place.`; the website starts |
| Joomla, Matomo | the installer opens; use the database values of the *Database* tab (password: show it there) |
| Nextcloud | the installer opens with the database already filled in; after setup `https://…/data/` and `/config/config.php` answer 404; `occ`/WebDAV (`/remote.php/dav`) work |
| Grav | the admin account is created on the first visit; `/user/accounts/` files and `/system/…yaml` answer 403 |

*Domains & HTTPS → Web server* shows the generated nginx rules for these templates. A task that fails at the download is the most useful thing to report (log + exit code).

### Metrics
Point a Prometheus at `/api/v1/metrics` with the viewer token (see the manual) or `curl -H "Authorization: Bearer wmt_…" https://…/api/v1/metrics`.
Stop a website: `webmanager_site_running` becomes 0 and, after a minute, `webmanager_site_up` is 0.

### Maintenance windows
1. *Hosting → Maintenance*: window for one website from now for 10 minutes; the list shows “Running”.
2. Stop that website, wait 3 minutes: **no** “not reachable” message arrives. Start it again: no “running again” message.
3. Delete the window while the website is still stopped: within about 2 minutes the “not reachable” message arrives.
4. A window for **all websites** also silences certificate/backup/ban messages; the *Send test notification* button still sends.
5. A daily window: set it for 5 minutes ahead and check that it shows “next: …” after it ended.

### Languages
A fresh browser (even one set to German) starts in English. Sign-in page: the language menu shows English and Deutsch. Choose Deutsch: the page, the navigation, *Maintenance* and *API tokens* are German;
a text that is not translated stays English. *My account → Language* switches back. Reload keeps the choice.
Add a language: `php scripts/i18n.php init fr "Français" fr-FR`, translate a few entries, copy `lang/fr.json` to the server (and into the dashboard image
or rebuild) – the menu offers it without a restart.

### DNS provider and wildcard certificates (use a test zone)
1. *System → DNS provider*: Cloudflare (token with *Zone:Read* + *DNS:Edit*) or Hetzner (Console token; the zone must be in the new Console). *Save and test*:
   the log shows `OK: the token sees N zone(s)` and the status turns green. A wrong token ends with the provider's message, not with the token.
2. A website: *Domains*: add `test.example.com` and `*.test.example.com`, save. *Set DNS records* → the A/AAAA records of both appear at the provider
   (a second click says `unchanged`).
3. *HTTPS*: issue the certificate. The log shows `validation through DNS`, `TXT record set …, waiting 30 s`, `TXT record removed`; afterwards the
   provider's zone contains no leftover `_acme-challenge` records. With staging the browser warns; `openssl s_client -connect host:443 -servername a.test.example.com`
   shows the wildcard name.
4. Renewal: *System → Updates* or the daily run (“Check/renew certificates now”): with a fresh certificate the log says that it is not yet due and
   ends without an error – this proves that the per-certificate renewal path (with the DNS mount) starts. A real renewal can be forced on the test
   server only with certbot's own `--force-renewal` on the staging certificate.
5. Removing the provider: confirm the warning; the renewal of DNS certificates then fails with “No DNS credentials are stored.” until it is set up again.
6. A wildcard on the **dashboard domain** is refused.

### What to report
For every failure: the page or API call, the task log (*Tasks*), and `docker compose logs --tail 100 agent worker`. Never send the DNS token.
