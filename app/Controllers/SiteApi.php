<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\Auth;
use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\Agent;
use WebManager\Services\JobQueue;
use WebManager\Services\SiteService;
use WebManager\Support\Audit;
use WebManager\Support\Db;

final class SiteApi
{
    private static function id(array $p): int
    {
        $id = filter_var($p['id'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 40000]]);
        if ($id === false) {
            throw new HttpException(404, 'Website not found');
        }
        return (int) $id;
    }

    /** @param array<string,mixed>|null $st */
    private static function displayState(array $site, ?array $st): string
    {
        if ($site['lifecycle'] === 'creating') {
            return 'creating';
        }
        if ($site['lifecycle'] === 'deleting') {
            return 'deleting';
        }
        if ($st === null) {
            return 'unknown';
        }
        if (empty($st['exists'])) {
            return 'missing';
        }
        $state = (string) ($st['state'] ?? '');
        if ($state === 'running') {
            return match ($st['health'] ?? null) {
                'starting' => 'starting',
                'unhealthy' => 'unhealthy',
                default => 'running',
            };
        }
        if ($state === 'restarting') {
            return 'crashed';
        }
        if (in_array($state, ['exited', 'dead'], true)) {
            return ((int) ($st['exitCode'] ?? 0) !== 0 && $site['desired_state'] === 'running') ? 'crashed' : 'stopped';
        }
        return $state ?: 'unknown';
    }

    public static function overview(Request $req): never
    {
        $rows = Db::all('SELECT * FROM sites ORDER BY name');
        $statuses = [];
        $stats = [];
        $agentError = null;
        try {
            $statuses = Agent::get('/v1/statuses', 20)['statuses'] ?? [];
            $stats = Agent::get('/v1/stats', 20)['stats'] ?? [];
        } catch (HttpException $e) {
            $agentError = $e->getMessage();
        }
        $domains = [];
        foreach (Db::all('SELECT site_id, domain FROM site_domains ORDER BY id') as $d) {
            $domains[(int) $d['site_id']][] = $d['domain'];
        }
        $certs = [];
        foreach (Db::all('SELECT * FROM certificates') as $c) {
            $certs[$c['name']] = $c;
        }
        // HTTP checks (worker, once a minute): share of successful checks of the last 24 hours and the latest result
        $up24 = [];
        foreach (Db::all('SELECT site_id, COUNT(*) AS n, SUM(ok) AS up FROM site_checks WHERE checked_at > NOW() - INTERVAL 24 HOUR GROUP BY site_id') as $u) {
            $up24[(int) $u['site_id']] = round(100 * (int) $u['up'] / max(1, (int) $u['n']), 2);
        }
        $lastCheck = [];
        foreach (Db::all('SELECT c.site_id, c.ok, c.status_code, c.ms, c.error, c.checked_at FROM site_checks c
                          JOIN (SELECT site_id, MAX(id) AS mid FROM site_checks WHERE checked_at > NOW() - INTERVAL 10 MINUTE GROUP BY site_id) m ON m.mid = c.id') as $c) {
            $lastCheck[(int) $c['site_id']] = [
                'ok' => (bool) $c['ok'], 'status' => $c['status_code'] === null ? null : (int) $c['status_code'],
                'ms' => $c['ms'] === null ? null : (int) $c['ms'], 'error' => $c['error'], 'at' => str_replace(' ', 'T', (string) $c['checked_at']) . 'Z',
            ];
        }
        $out = [];
        foreach ($rows as $r) {
            $id = (int) $r['id'];
            $st = $agentError === null ? ($statuses[(string) $id] ?? ['exists' => false]) : null;
            $slug = SiteService::siteName($id);
            $out[] = SiteService::present($r) + [
                'domains' => $domains[$id] ?? [],
                'state' => self::displayState($r, $st),
                'status' => $st,
                'stats' => $stats[(string) $id] ?? null,
                'tls' => $st['tls'] ?? false,
                'cert_status' => $certs[$slug]['status'] ?? 'none',
                'cert_not_after' => $certs[$slug]['not_after'] ?? null,
                'busy' => JobQueue::hasActive($id),
                'uptime' => ['pct24' => $up24[$id] ?? null, 'last' => $lastCheck[$id] ?? null],
            ];
        }
        Response::json(['sites' => $out, 'agent_error' => $agentError]);
    }

    /** Approved runtime templates, for the "new website" form (operators). */
    public static function runtimes(Request $req): never
    {
        // runtimes that only an application template uses (templateOnly) are not offered in the form
        $list = array_filter(SiteService::runtimes(), static fn ($v) => empty($v['templateOnly']));
        Response::json(['runtimes' => array_values(array_map(
            static fn ($k, $v) => ['key' => $k, 'label' => $v['label'], 'types' => $v['types'], 'fixedPort' => $v['fixedPort'] ?? null, 'npm' => !empty($v['npm']), 'templateOnly' => false, 'image' => $v['image']],
            array_keys($list),
            $list
        ))]);
    }

    /** Application templates for “Start from” (operators). */
    public static function apps(Request $req): never
    {
        Response::json(['apps' => array_map(
            static fn ($k, $v) => ['key' => $k, 'label' => $v['label'], 'description' => $v['description'], 'type' => $v['type'], 'database' => $v['database'] ?? null, 'memory_mb' => $v['memory_mb'], 'after' => $v['after'] ?? ''],
            array_keys(SiteService::apps()),
            SiteService::apps()
        )]);
    }

    public static function show(Request $req, array $p): never
    {
        $id = self::id($p);
        $r = SiteService::row($id);
        $st = null;
        $error = null;
        try {
            $st = Agent::get("/v1/sites/$id/status");
        } catch (HttpException $e) {
            $error = $e->getMessage();
        }
        $slug = SiteService::siteName($id);
        Response::json([
            'site' => SiteService::present($r),
            'domains' => SiteService::domains($id),
            'status' => $st,
            'state' => self::displayState($r, $st),
            'agent_error' => $error,
            'cert' => Db::one('SELECT * FROM certificates WHERE name = ?', [$slug]),
            'busy' => JobQueue::hasActive($id),
            'runtimes' => array_map(static fn ($k, $v) => ['key' => $k, 'label' => $v['label'], 'types' => $v['types'], 'fixedPort' => $v['fixedPort'] ?? null, 'npm' => !empty($v['npm']), 'templateOnly' => !empty($v['templateOnly'])], array_keys(SiteService::runtimes()), SiteService::runtimes()),
        ]);
    }

    public static function create(Request $req): never
    {
        $user = Auth::user();
        $res = SiteService::create($req->json(), (int) $user['id']);
        Response::json($res, 201);
    }

    public static function duplicate(Request $req, array $p): never
    {
        $id = self::id($p);
        $in = $req->json();
        $user = Auth::user();
        $res = SiteService::duplicate($id, trim((string) ($in['name'] ?? '')), !empty($in['copy_files']), !empty($in['copy_env']), (int) $user['id']);
        Response::json($res, 201);
    }

    public static function update(Request $req, array $p): never
    {
        $id = self::id($p);
        $job = SiteService::update($id, $req->json());
        Response::json(['job' => $job]);
    }

    public static function delete(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $in = $req->json();
        if (($in['confirm'] ?? '') !== $site['name']) {
            throw new HttpException(422, 'To confirm, the website name must be entered exactly.');
        }
        if ($site['lifecycle'] === 'deleting') {
            throw new HttpException(409, 'The website is already being deleted.');
        }
        Db::exec("UPDATE sites SET lifecycle = 'deleting' WHERE id = ?", [$id]);
        $purge = !empty($in['purge']);
        $job = JobQueue::enqueue('site.delete', $id, 'Delete website “' . $site['name'] . '”', ['purge' => $purge]);
        Audit::log('site.delete', SiteService::siteName($id), ['name' => $site['name'], 'purge' => $purge]);
        Response::json(['job' => $job]);
    }

    public static function action(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $action = (string) ($req->json()['action'] ?? '');
        $titles = ['start' => 'Start', 'stop' => 'Stop', 'restart' => 'Restart', 'apply' => 'Update container of'];
        if (!isset($titles[$action])) {
            throw new HttpException(422, 'Unknown action');
        }
        if ($site['lifecycle'] !== 'ready') {
            throw new HttpException(409, 'The website is not ready yet.');
        }
        $type = $action === 'apply' ? 'site.apply' : 'site.' . $action;
        $job = JobQueue::enqueue($type, $id, '„' . $site['name'] . '“ ' . $titles[$action], $action === 'apply' ? ['restart' => true] : []);
        Audit::log('site.' . $action, SiteService::siteName($id));
        Response::json(['job' => $job]);
    }

    public static function status(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $st = Agent::get("/v1/sites/$id/status");
        $stats = [];
        try {
            $stats = Agent::get("/v1/stats?ids=$id")['stats'][(string) $id] ?? null;
        } catch (HttpException) {
            $stats = null;
        }
        Response::json(['status' => $st, 'stats' => $stats, 'state' => self::displayState($site, $st)]);
    }

    public static function logs(Request $req, array $p): never
    {
        $id = self::id($p);
        SiteService::row($id);
        $source = $req->q('source', 'container');
        $tail = max(1, min((int) $req->q('tail', '200'), 2000));
        if ($source === 'container') {
            Response::json(Agent::get("/v1/sites/$id/logs?tail=$tail"));
        }
        if (!in_array($source, ['access', 'error'], true)) {
            throw new HttpException(422, 'Unknown log source');
        }
        Response::json(Agent::get("/v1/sites/$id/applog?name=$source.log&lines=$tail"));
    }

    public static function getEnv(Request $req, array $p): never
    {
        $id = self::id($p);
        SiteService::row($id);
        Response::json(['env' => (object) SiteService::env($id)]);
    }

    public static function putEnv(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $in = $req->json();
        $env = SiteService::validateEnv($in['env'] ?? []);
        SiteService::setEnv($id, $env);
        $job = JobQueue::enqueue('site.apply', $id, 'Apply environment variables of “' . $site['name'] . '”', ['restart' => false]);
        Response::json(['job' => $job]);
    }

    public static function putDomains(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $list = $req->json()['domains'] ?? [];
        if (!is_array($list) || count($list) > 20) {
            throw new HttpException(422, 'Invalid domain list (max. 20).');
        }
        $domains = SiteService::validateDomains($list, $id);
        SiteService::setDomains($id, $domains);
        $job = JobQueue::enqueue('site.apply', $id, 'Apply domains of “' . $site['name'] . '”', ['restart' => false]);
        Response::json(['job' => $job, 'domains' => $domains]);
    }

    private static function defaultNginx(array $site): ?string
    {
        $kind = SiteService::runtimes()[$site['runtime']]['kind'] ?? '';
        if (!in_array($kind, ['static', 'php'], true)) {
            return null;
        }
        $t = (string) file_get_contents(WM_ROOT . '/templates/site/' . ($kind === 'php' ? 'php' : 'static') . '.nginx.conf');
        return str_replace(['{{APP_RULES}}', '{{DOCROOT}}'], ['', (string) $site['docroot']], $t);
    }

    public static function getWebserver(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $default = self::defaultNginx($site);
        Response::json([
            'supported' => $default !== null,
            'engine' => 'nginx',
            'default' => $default,
            'custom' => $site['webserver_conf'],
        ]);
    }

    public static function putWebserver(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        if (self::defaultNginx($site) === null) {
            throw new HttpException(422, 'This website type has no web server configuration.');
        }
        $conf = str_replace("\r\n", "\n", (string) ($req->json()['config'] ?? ''));
        if (strlen($conf) > 65536 || str_contains($conf, "\0")) {
            throw new HttpException(422, 'Configuration is too large (max. 64 KB).');
        }
        $conf = trim($conf) === '' ? null : $conf;
        Db::exec('UPDATE sites SET webserver_conf = ? WHERE id = ?', [$conf, $id]);
        Audit::log('site.webserver', SiteService::siteName($id), ['custom' => $conf !== null]);
        $job = JobQueue::enqueue('site.apply', $id, 'Apply web server configuration of “' . $site['name'] . '”', ['restart' => true]);
        Response::json(['job' => $job]);
    }

    public static function dnsCheck(Request $req, array $p): never
    {
        $id = self::id($p);
        SiteService::row($id);
        Response::json(Agent::request('POST', '/v1/certs/dns', ['domains' => SiteService::domains($id)], null, 30));
    }

    public static function certStatus(Request $req, array $p): never
    {
        $id = self::id($p);
        SiteService::row($id);
        $slug = SiteService::siteName($id);
        $info = Agent::get("/v1/certs/$slug");
        $verify = [];
        if (!empty($info['exists']) && $req->q('verify') === '1') {
            foreach (SiteService::domains($id) as $d) {
                $verify[] = Agent::request('POST', '/v1/certs/verify', ['domain' => $d], null, 15);
            }
        }
        Response::json(['cert' => $info, 'verify' => $verify, 'db' => Db::one('SELECT * FROM certificates WHERE name = ?', [$slug])]);
    }

    public static function issueCert(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $in = $req->json();
        if (empty($in['accept_tos'])) {
            throw new HttpException(422, 'The Let\'s Encrypt terms of service must be accepted.');
        }
        $email = trim((string) ($in['email'] ?? ''));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 190) {
            throw new HttpException(422, 'Please enter a valid contact email address.');
        }
        if (!SiteService::domains($id)) {
            throw new HttpException(422, 'No domains are assigned to the website yet.');
        }
        $wildcard = (bool) array_filter(SiteService::domains($id), static fn ($d) => str_starts_with((string) $d, '*.'));
        $viaDns = !empty($in['dns']) || $wildcard;
        if ($viaDns && !DnsApi::configured()) {
            throw new HttpException(422, $wildcard
                ? 'A wildcard domain needs validation through DNS. An administrator has to set up a DNS provider first (System → DNS provider).'
                : 'No DNS provider is set up (System → DNS provider).');
        }
        Db::exec("REPLACE INTO settings (k, v) VALUES ('acme_email', ?)", [$email]);
        $job = JobQueue::enqueue('site.cert', $id, 'Set up HTTPS certificate for “' . $site['name'] . '”', ['email' => $email, 'dns' => $viaDns]);
        Audit::log('site.cert', SiteService::siteName($id), ['email' => $email, 'dns' => $viaDns]);
        Response::json(['job' => $job]);
    }

    public static function scripts(Request $req, array $p): never
    {
        $id = self::id($p);
        SiteService::row($id);
        Response::json(Agent::get("/v1/sites/$id/package-scripts"));
    }

    public static function command(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $in = $req->json();
        $kind = (string) ($in['kind'] ?? '');
        $rtDef = SiteService::runtimes()[$site['runtime']] ?? [];
        $isNode = !empty($rtDef['npm']);
        $payload = [
            'restartAfter' => !empty($in['restart_after']),
            'runInstall' => !empty($in['run_install']),
            'runBuild' => !empty($in['run_build']),
        ];
        switch ($kind) {
            case 'npm_install':
                $payload += ['kind' => 'npm', 'sub' => 'install'];
                $title = 'npm install';
                break;
            case 'npm_ci':
                $payload += ['kind' => 'npm', 'sub' => 'ci'];
                $title = 'npm ci';
                break;
            case 'npm_script':
                $script = (string) ($in['script'] ?? '');
                if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/', $script)) {
                    throw new HttpException(422, 'Invalid script name');
                }
                $payload += ['kind' => 'npm', 'sub' => 'run', 'script' => $script];
                $title = 'npm run ' . $script;
                break;
            case 'install':
                $payload += ['kind' => 'shell', 'which' => 'install'];
                $title = 'Install command';
                break;
            case 'build':
                $payload += ['kind' => 'shell', 'which' => 'build'];
                $title = 'Build command';
                break;
            case 'git_sync':
                $payload += ['kind' => 'git'];
                $title = 'Load from Git';
                break;
            case 'composer_install':
            case 'artisan_migrate':
            case 'artisan_storage_link':
            case 'artisan_optimize':
            case 'artisan_optimize_clear':
                if ($site['type'] !== 'laravel') {
                    throw new HttpException(422, 'This command is only available for Laravel websites.');
                }
                $payload += ['kind' => 'shell', 'preset' => $kind];
                $title = [
                    'composer_install' => 'composer install',
                    'artisan_migrate' => 'php artisan migrate --force',
                    'artisan_storage_link' => 'php artisan storage:link',
                    'artisan_optimize' => 'php artisan optimize',
                    'artisan_optimize_clear' => 'php artisan optimize:clear',
                ][$kind];
                break;
            case 'extract':
                $archive = (string) ($in['archive'] ?? '');
                if (!preg_match('/^.?[A-Za-z0-9][A-Za-z0-9._-]{0,99}.(zip|tar.gz|tgz)$/', $archive) || str_contains($archive, '..')) {
                    throw new HttpException(422, 'Invalid archive name (allowed: .zip, .tar.gz, .tgz).');
                }
                $payload += ['kind' => 'extract', 'archive' => $archive, 'strip' => !isset($in['strip']) || !empty($in['strip'])];
                $title = 'Extract archive';
                break;
            default:
                throw new HttpException(422, 'Unknown task');
        }
        if ($payload['kind'] === 'npm' && !$isNode) {
            throw new HttpException(422, 'npm commands are only available for Node.js runtimes.');
        }
        if ($payload['kind'] === 'git' && $site['git_url'] === '') {
            throw new HttpException(422, 'No Git repository is stored for this website.');
        }
        if ($site['lifecycle'] !== 'ready') {
            throw new HttpException(409, 'The website is not ready yet.');
        }
        $job = JobQueue::enqueue('site.exec', $id, $title . ' – „' . $site['name'] . '“', $payload);
        Audit::log('site.command', SiteService::siteName($id), ['command' => $title]);
        Response::json(['job' => $job]);
    }

    public static function metrics(Request $req, array $p): never
    {
        $id = self::id($p);
        SiteService::row($id);
        $range = $req->q('range', '24h');
        if (!in_array($range, ['1h', '24h', '7d', '30d'], true)) {
            throw new HttpException(422, 'Unknown period');
        }
        Response::json(Agent::get("/v1/sites/$id/metrics?range=$range", 30));
    }

    public static function jobs(Request $req, array $p): never
    {
        $id = self::id($p);
        SiteService::row($id);
        Response::json(['jobs' => JobQueue::recent($id, 20)]);
    }

    private static function pct(mixed $up, mixed $n): ?float
    {
        return (int) $n > 0 ? round(100 * (int) $up / (int) $n, 2) : null;
    }

    /** History of the HTTP checks: uptime per period, half-hour buckets (24 h), day buckets (14 days) and the latest failed checks. */
    public static function uptime(Request $req, array $p): never
    {
        $id = self::id($p);
        SiteService::row($id);
        $s = Db::one(
            'SELECT COUNT(*) AS n, SUM(ok) AS up,
                    SUM(checked_at > NOW() - INTERVAL 24 HOUR) AS n24, SUM(ok = 1 AND checked_at > NOW() - INTERVAL 24 HOUR) AS up24,
                    SUM(checked_at > NOW() - INTERVAL 7 DAY) AS n7, SUM(ok = 1 AND checked_at > NOW() - INTERVAL 7 DAY) AS up7,
                    AVG(CASE WHEN ok = 1 AND checked_at > NOW() - INTERVAL 24 HOUR THEN ms END) AS ms24
             FROM site_checks WHERE site_id = ?',
            [$id]
        ) ?? [];
        $bucket = static function (int $seconds, string $interval) use ($id): array {
            $rows = Db::all(
                "SELECT FLOOR(UNIX_TIMESTAMP(checked_at) / $seconds) * $seconds AS t, COUNT(*) AS n, SUM(ok) AS up, ROUND(AVG(ms)) AS ms
                 FROM site_checks WHERE site_id = ? AND checked_at > NOW() - INTERVAL $interval GROUP BY t ORDER BY t",
                [$id]
            );
            return array_map(static fn (array $r): array => [
                't' => (int) $r['t'], 'n' => (int) $r['n'], 'up' => (int) $r['up'], 'ms' => $r['ms'] === null ? null : (int) $r['ms'],
            ], $rows);
        };
        $failures = array_map(static fn (array $r): array => [
            'at' => str_replace(' ', 'T', (string) $r['checked_at']) . 'Z',
            'status' => $r['status_code'] === null ? null : (int) $r['status_code'],
            'error' => (string) ($r['error'] ?? ''),
        ], Db::all('SELECT checked_at, status_code, error FROM site_checks WHERE site_id = ? AND ok = 0 ORDER BY id DESC LIMIT 20', [$id]));
        Response::json([
            'summary' => [
                'checks' => (int) ($s['n'] ?? 0),
                'pct24' => self::pct($s['up24'] ?? 0, $s['n24'] ?? 0),
                'pct7' => self::pct($s['up7'] ?? 0, $s['n7'] ?? 0),
                'pct14' => self::pct($s['up'] ?? 0, $s['n'] ?? 0),
                'ms24' => isset($s['ms24']) ? (int) round((float) $s['ms24']) : null,
            ],
            'hours' => $bucket(1800, '24 HOUR'),
            'days' => $bucket(86400, '14 DAY'),
            'failures' => $failures,
        ]);
    }

    /** Limits, current use, restarts and the disk space of the last 30 days (sampled daily by the worker). */
    public static function resources(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $usage = null;
        $status = null;
        try {
            $usage = Agent::get("/v1/stats?ids=$id", 20)['stats'][(string) $id] ?? null;
            $status = Agent::get("/v1/sites/$id/status");
        } catch (HttpException) {
            // the agent is not reachable: limits and disk history are still shown
        }
        $disk = Db::all('SELECT day, bytes FROM site_disk WHERE site_id = ? AND day >= CURDATE() - INTERVAL 30 DAY ORDER BY day', [$id]);
        Response::json([
            'limits' => ['memory_mb' => (int) $site['memory_mb'], 'cpus' => (float) $site['cpus'], 'pids' => (int) $site['pids']],
            'usage' => $usage,
            'restarts' => isset($status['restartCount']) ? (int) $status['restartCount'] : null,
            'oom' => !empty($status['oomKilled']),
            'disk' => array_map(static fn (array $r): array => ['day' => (string) $r['day'], 'bytes' => (int) $r['bytes']], $disk),
        ]);
    }
}
