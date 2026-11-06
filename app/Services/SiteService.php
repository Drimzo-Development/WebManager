<?php
declare(strict_types=1);

namespace WebManager\Services;

use WebManager\Http\HttpException;
use WebManager\Support\Audit;
use WebManager\Support\Crypto;
use WebManager\Support\Db;

final class SiteService
{
    public const TYPES = ['static', 'php', 'laravel', 'node', 'express', 'next', 'custom'];
    private const DOMAIN_RE = '/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/';
    private const ENV_RE = '/^[A-Za-z_][A-Za-z0-9_]{0,127}$/';
    private const ENV_BLOCKED = '/^(PATH|HOME|USER|PORT|HOSTNAME|PWD|SHELL|LD_.*|DOCKER_.*|BASH_ENV|ENV|IFS)$/';

    /** @return array<string,mixed> */
    public static function runtimes(): array
    {
        static $doc = null;
        if ($doc === null) {
            $doc = json_decode((string) file_get_contents(WM_ROOT . '/templates/runtimes.json'), true, 512, JSON_THROW_ON_ERROR);
        }
        return $doc['runtimes'];
    }

    /** Application templates (“Start from” in the new-website form), see templates/apps.json. @return array<string,array<string,mixed>> */
    public static function apps(): array
    {
        static $doc = null;
        if ($doc === null) {
            $doc = json_decode((string) file_get_contents(WM_ROOT . '/templates/apps.json'), true, 512, JSON_THROW_ON_ERROR);
        }
        return $doc['apps'];
    }

    private static function randomSecret(int $len = 32): string
    {
        $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        $out = '';
        for ($i = 0; $i < $len; $i++) {
            $out .= $chars[random_int(0, strlen($chars) - 1)];
        }
        return $out;
    }

    /** Defaults applied per website type. @return array<string,string> */
    public static function defaults(string $type): array
    {
        return match ($type) {
            'node', 'express' => ['install_command' => 'npm install', 'build_command' => '', 'start_command' => 'npm start'],
            'laravel' => ['install_command' => 'composer install --no-dev --optimize-autoloader --no-interaction', 'build_command' => 'if [ -f package.json ]; then npm ci && npm run build; fi', 'start_command' => ''],
            'next' => ['install_command' => 'npm install', 'build_command' => 'npm run build', 'start_command' => 'npm start'],
            default => ['install_command' => '', 'build_command' => '', 'start_command' => ''],
        };
    }

    public static function siteName(int $id): string
    {
        return sprintf('site-%03d', $id);
    }

    /** Host name; a wildcard (`*.example.com`) only where the caller allows it (websites, validated through DNS). */
    public static function normalizeDomain(string $d, bool $allowWildcard = false): string
    {
        $d = strtolower(trim($d));
        $d = rtrim($d, '.');
        $base = $allowWildcard && str_starts_with($d, '*.') ? substr($d, 2) : $d;
        if (!preg_match(self::DOMAIN_RE, $base)) {
            throw new HttpException(422, 'Invalid domain: ' . mb_substr($d, 0, 80));
        }
        return $d;
    }

    /** @param array<string,mixed> $in @return array<string,mixed> */
    public static function validate(array $in, ?int $existingId = null): array
    {
        $errors = [];
        $s = [];
        $s['name'] = trim((string) ($in['name'] ?? ''));
        if (mb_strlen($s['name']) < 2 || mb_strlen($s['name']) > 100 || !preg_match('/^[\p{L}\p{N} ._-]+$/u', $s['name'])) {
            $errors['name'] = 'Name: 2–100 characters (letters, digits, spaces, dot, hyphen, underscore).';
        } else {
            $dup = Db::val('SELECT id FROM sites WHERE name = ? AND id <> ?', [$s['name'], $existingId ?? 0]);
            if ($dup) {
                $errors['name'] = 'A website with this name already exists.';
            }
        }
        $s['description'] = mb_substr(trim((string) ($in['description'] ?? '')), 0, 500);

        $type = (string) ($in['type'] ?? '');
        if (!in_array($type, self::TYPES, true)) {
            $errors['type'] = 'Unknown application type.';
            $type = 'static';
        }
        $s['type'] = $type;

        $runtimes = self::runtimes();
        $runtime = (string) ($in['runtime'] ?? '');
        if (!isset($runtimes[$runtime]) || !in_array($type, $runtimes[$runtime]['types'], true)) {
            $errors['runtime'] = 'The runtime template is not approved or does not match the type.';
        }
        $s['runtime'] = $runtime;
        $fixed = $runtimes[$runtime]['fixedPort'] ?? null;
        $port = $fixed ?? filter_var($in['internal_port'] ?? 3000, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1024, 'max_range' => 65535]]);
        if ($port === false) {
            $errors['internal_port'] = 'Internal port: 1024–65535.';
            $port = 3000;
        }
        $s['internal_port'] = (int) $port;

        $docroot = trim((string) ($in['docroot'] ?? ''), " \t/");
        if ($docroot === '' && $type === 'laravel') {
            $docroot = 'public';
        }
        if ($docroot !== '' && (!preg_match('#^[A-Za-z0-9_\-./]{1,100}$#', $docroot) || in_array('..', explode('/', $docroot), true))) {
            $errors['docroot'] = 'Document root: relative path without “..”.';
            $docroot = '';
        }
        $s['docroot'] = $docroot;

        $mem = filter_var($in['memory_mb'] ?? 512, FILTER_VALIDATE_INT, ['options' => ['min_range' => 64, 'max_range' => 16384]]);
        if ($mem === false) {
            $errors['memory_mb'] = 'Memory: 64–16384 MB.';
            $mem = 512;
        }
        $s['memory_mb'] = (int) $mem;
        $cpus = filter_var($in['cpus'] ?? 1, FILTER_VALIDATE_FLOAT);
        if ($cpus === false || $cpus < 0.1 || $cpus > 16) {
            $errors['cpus'] = 'CPU-Limit: 0,1–16.';
            $cpus = 1.0;
        }
        $s['cpus'] = round((float) $cpus, 2);
        $pids = filter_var($in['pids'] ?? 256, FILTER_VALIDATE_INT, ['options' => ['min_range' => 16, 'max_range' => 4096]]);
        if ($pids === false) {
            $errors['pids'] = 'Prozesslimit: 16–4096.';
            $pids = 256;
        }
        $s['pids'] = (int) $pids;

        $d = self::defaults($type);
        foreach (['install_command', 'build_command', 'start_command'] as $f) {
            $v = array_key_exists($f, $in) ? trim((string) $in[$f]) : $d[$f];
            if (mb_strlen($v) > 1000 || str_contains($v, "\0")) {
                $errors[$f] = 'Command is too long (max. 1000 characters).';
                $v = '';
            }
            $s[$f] = $v;
        }
        if (in_array($type, ['custom'], true) && $s['start_command'] === '') {
            $errors['start_command'] = 'A start command is required for custom applications.';
        }

        $git = trim((string) ($in['git_url'] ?? ''));
        if ($git !== '' && !preg_match('#^https://[A-Za-z0-9._~:@%/+=?&\#-]{4,480}$#', $git)) {
            $errors['git_url'] = 'Only https:// repository URLs are allowed.';
            $git = '';
        }
        $s['git_url'] = $git;
        $branch = trim((string) ($in['git_branch'] ?? ''));
        if ($branch !== '' && (!preg_match('#^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$#', $branch) || str_contains($branch, '..'))) {
            $errors['git_branch'] = 'Invalid branch name.';
            $branch = '';
        }
        $s['git_branch'] = $branch;
        $gitUser = trim((string) ($in['git_username'] ?? ''));
        if ($gitUser !== '' && !preg_match('/^[A-Za-z0-9._@-]{1,100}$/', $gitUser)) {
            $errors['git_username'] = 'Invalid Git username.';
            $gitUser = '';
        }
        $s['git_username'] = $gitUser;
        $tok = (string) ($in['git_token'] ?? '');
        if ($tok !== '' && !preg_match('/^[!-~]{1,300}$/', $tok)) {
            $errors['git_token'] = 'Invalid access token (no spaces, max. 300 characters).';
        }
        $s['autostart'] = !empty($in['autostart']) ? 1 : 0;

        if ($errors) {
            throw new HttpException(422, 'Please check the inputs.', ['fields' => $errors]);
        }
        return $s;
    }

    /** @param mixed $env @return array<string,string> */
    public static function validateEnv(mixed $env): array
    {
        if ($env === null || $env === '') {
            return [];
        }
        if (!is_array($env) || count($env) > 200) {
            throw new HttpException(422, 'Invalid environment variables (max. 200).');
        }
        $out = [];
        foreach ($env as $k => $v) {
            $k = (string) $k;
            if (!preg_match(self::ENV_RE, $k) || preg_match(self::ENV_BLOCKED, $k)) {
                throw new HttpException(422, "Invalid or reserved variable name: $k");
            }
            if (!is_string($v) || strlen($v) > 4096 || preg_match('/[\0\r\n]/', $v)) {
                throw new HttpException(422, "Value of $k is invalid (single line, max. 4096 characters).");
            }
            $out[$k] = $v;
        }
        return $out;
    }

    /** @param list<mixed> $domains @return list<string> */
    public static function validateDomains(array $domains, ?int $siteId = null): array
    {
        $out = [];
        $dash = (string) Db::val("SELECT v FROM settings WHERE k = 'dashboard_domain'");
        foreach ($domains as $d) {
            $d = self::normalizeDomain((string) $d, true);
            if ($dash !== '' && $d === $dash) {
                throw new HttpException(422, "$d is the dashboard domain.");
            }
            $owner = Db::val('SELECT site_id FROM site_domains WHERE domain = ?', [$d]);
            if ($owner !== null && (int) $owner !== $siteId) {
                throw new HttpException(422, "$d is already assigned to another website.");
            }
            $out[] = $d;
        }
        return array_values(array_unique($out));
    }

    /**
     * @param array<string,mixed> $in
     * @return array{site:int,job:int}
     */
    public static function create(array $in, int $userId): array
    {
        // an application template fixes type, runtime and size; the rest of the form (name, description, domains) stays
        $app = null;
        $appKey = (string) ($in['app'] ?? '');
        if ($appKey !== '') {
            $app = self::apps()[$appKey] ?? null;
            if ($app === null) {
                throw new HttpException(422, 'Unknown application template.');
            }
            $runtime = null;
            foreach ((array) ($app['runtimePreference'] ?? []) as $candidate) {
                if (isset(self::runtimes()[$candidate]) && in_array($app['type'], self::runtimes()[$candidate]['types'], true)) {
                    $runtime = $candidate;
                    break;
                }
            }
            if ($runtime === null) {
                throw new HttpException(422, 'No suitable runtime is available for this template.');
            }
            $in = array_merge($in, [
                'type' => $app['type'], 'runtime' => $runtime, 'memory_mb' => (int) $app['memory_mb'], 'docroot' => (string) ($app['docroot'] ?? ''),
                'git_url' => '', 'git_branch' => '', 'git_username' => '', 'git_token' => '',
                'install_command' => '', 'build_command' => '', 'start_command' => (string) ($app['startCommand'] ?? ''), 'autostart' => true,
                // an application that ships in its image fixes the port and brings its own environment (the form's values are added)
                'internal_port' => (int) ($app['internalPort'] ?? ($in['internal_port'] ?? 3000)),
                'env' => array_merge((array) ($app['env'] ?? []), is_array($in['env'] ?? null) ? $in['env'] : []),
            ]);
        }
        $s = self::validate($in);
        $env = self::validateEnv($in['env'] ?? []);
        $domains = self::validateDomains(is_array($in['domains'] ?? null) ? $in['domains'] : []);
        $pdo = Db::pdo();
        $pdo->beginTransaction();
        try {
            $id = Db::insert(
                'INSERT INTO sites (name, description, type, runtime, internal_port, docroot, memory_mb, cpus, pids, start_command,
                    install_command, build_command, git_url, git_branch, git_username, git_token_enc, autostart, desired_state, lifecycle, created_by)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                [$s['name'], $s['description'], $s['type'], $s['runtime'], $s['internal_port'], $s['docroot'], $s['memory_mb'], $s['cpus'], $s['pids'],
                    $s['start_command'], $s['install_command'], $s['build_command'], $s['git_url'], $s['git_branch'], $s['git_username'],
                    ($in['git_token'] ?? '') !== '' ? Crypto::encrypt((string) $in['git_token']) : null, $s['autostart'], 'stopped', 'creating', $userId]
            );
            if ($id > 40000) {
                throw new HttpException(422, 'Maximum number of websites reached.');
            }
            foreach ($env as $k => $v) {
                Db::exec('INSERT INTO site_env (site_id, name, value_enc) VALUES (?,?,?)', [$id, $k, Crypto::encrypt($v)]);
            }
            foreach ($domains as $d) {
                Db::exec('INSERT INTO site_domains (site_id, domain) VALUES (?,?)', [$id, $d]);
            }
            if ($app !== null && !empty($app['nginxRules'])) {
                // rules that keep the private directories of the application away from visitors; the site owner can see and edit them
                $tpl = (string) file_get_contents(WM_ROOT . '/templates/site/php.nginx.conf');
                Db::exec(
                    'UPDATE sites SET webserver_conf = ? WHERE id = ?',
                    [str_replace(['{{APP_RULES}}', '{{DOCROOT}}'], [implode("\n", array_map(static fn ($r) => '        ' . $r, (array) $app['nginxRules'])) . "\n", $s['docroot']], $tpl), $id]
                );
            }
            if ($app !== null && !empty($app['database'])) {
                Db::exec(
                    'UPDATE sites SET db_enabled = 1, db_engine = ?, db_name = ?, db_user = ?, db_password_enc = ?, db_root_enc = ?, db_memory_mb = ? WHERE id = ?',
                    [(string) $app['database'], 'app', 'app', Crypto::encrypt(self::randomSecret()),
                        $app['database'] === 'mariadb' ? Crypto::encrypt(self::randomSecret()) : null, (int) ($app['db_memory_mb'] ?? 512), $id]
                );
            }
            $hasGit = $s['git_url'] !== '';
            $selfContained = in_array($s['type'], ['static', 'php', 'laravel'], true) || ($s['type'] === 'custom' && $s['start_command'] !== '');
            $payload = [
                'runInstall' => $hasGit,
                'runBuild' => $hasGit,
                'start' => $hasGit || $selfContained,
            ];
            if ($app !== null) {
                $payload['app'] = $appKey;
            }
            $job = JobQueue::enqueue('site.create', $id, ($app !== null ? 'Create ' . $app['label'] . ' website “' : 'Create website “') . $s['name'] . '”', $payload);
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        Audit::log('site.create', self::siteName($id), ['name' => $s['name'], 'type' => $s['type'], 'runtime' => $s['runtime']] + ($app !== null ? ['app' => $appKey] : []));
        return ['site' => $id, 'job' => $job];
    }

    /**
     * Creates a copy of a website (settings, optionally environment and files) without domains, password gate and maintenance mode.
     *
     * @return array{site:int,job:int}
     */
    public static function duplicate(int $sourceId, string $name, bool $copyFiles, bool $copyEnv, int $userId): array
    {
        $src = self::row($sourceId);
        if ($src['lifecycle'] !== 'ready') {
            throw new HttpException(409, 'The website is not ready yet.');
        }
        $s = self::validate(array_merge($src, ['name' => $name, 'autostart' => (bool) $src['autostart']]));
        $pdo = Db::pdo();
        $pdo->beginTransaction();
        try {
            $id = Db::insert(
                'INSERT INTO sites (name, description, type, runtime, internal_port, docroot, memory_mb, cpus, pids, start_command,
                    install_command, build_command, webserver_conf, git_url, git_branch, git_username, git_token_enc, autostart, desired_state, lifecycle, created_by)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                [$s['name'], $s['description'], $s['type'], $s['runtime'], $s['internal_port'], $s['docroot'], $s['memory_mb'], $s['cpus'], $s['pids'],
                    $s['start_command'], $s['install_command'], $s['build_command'], $src['webserver_conf'], $s['git_url'], $s['git_branch'], $s['git_username'],
                    $src['git_token_enc'], $s['autostart'], 'stopped', 'creating', $userId]
            );
            if ($id > 40000) {
                throw new HttpException(422, 'Maximum number of websites reached.');
            }
            if ($copyEnv) {
                foreach (Db::all('SELECT name, value_enc FROM site_env WHERE site_id = ?', [$sourceId]) as $e) {
                    Db::exec('INSERT INTO site_env (site_id, name, value_enc) VALUES (?,?,?)', [$id, $e['name'], $e['value_enc']]);
                }
            }
            $job = JobQueue::enqueue('site.clone', $id, 'Create website “' . $s['name'] . '” as a copy of “' . $src['name'] . '”', [
                'source' => $sourceId,
                'copyFiles' => $copyFiles,
                'start' => $src['desired_state'] === 'running' && (bool) $s['autostart'],
            ]);
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        Audit::log('site.duplicate', self::siteName($id), ['from' => self::siteName($sourceId), 'files' => $copyFiles, 'env' => $copyEnv]);
        return ['site' => $id, 'job' => $job];
    }

    /** @param array<string,mixed> $in @return int job id */
    public static function update(int $id, array $in): int
    {
        $site = self::row($id);
        $merged = array_merge($site, $in);
        $merged['autostart'] = array_key_exists('autostart', $in) ? !empty($in['autostart']) : (bool) $site['autostart'];
        $s = self::validate($merged, $id);
        if ($s['type'] !== $site['type']) {
            throw new HttpException(422, 'The application type cannot be changed later.');
        }
        Db::exec(
            'UPDATE sites SET name=?, description=?, runtime=?, internal_port=?, docroot=?, memory_mb=?, cpus=?, pids=?, start_command=?,
                install_command=?, build_command=?, git_url=?, git_branch=?, git_username=?, autostart=? WHERE id=?',
            [$s['name'], $s['description'], $s['runtime'], $s['internal_port'], $s['docroot'], $s['memory_mb'], $s['cpus'], $s['pids'],
                $s['start_command'], $s['install_command'], $s['build_command'], $s['git_url'], $s['git_branch'], $s['git_username'], $s['autostart'], $id]
        );
        if (!empty($in['git_token_clear'])) {
            Db::exec('UPDATE sites SET git_token_enc = NULL WHERE id = ?', [$id]);
        } elseif (($in['git_token'] ?? '') !== '') {
            Db::exec('UPDATE sites SET git_token_enc = ? WHERE id = ?', [Crypto::encrypt((string) $in['git_token']), $id]);
        }
        Audit::log('site.update', self::siteName($id), ['name' => $s['name']]);
        return JobQueue::enqueue('site.apply', $id, 'Apply configuration of “' . $s['name'] . '”', ['restart' => false]);
    }

    /** @return array<string,mixed> */
    public static function row(int $id): array
    {
        $r = Db::one('SELECT * FROM sites WHERE id = ?', [$id]);
        if (!$r) {
            throw new HttpException(404, 'Website not found');
        }
        return $r;
    }

    /** @param array<string,mixed> $r @return array<string,mixed> */
    public static function present(array $r): array
    {
        return [
            'id' => (int) $r['id'],
            'slug' => self::siteName((int) $r['id']),
            'name' => $r['name'],
            'description' => $r['description'],
            'type' => $r['type'],
            'runtime' => $r['runtime'],
            'internal_port' => (int) $r['internal_port'],
            'docroot' => $r['docroot'],
            'memory_mb' => (int) $r['memory_mb'],
            'cpus' => (float) $r['cpus'],
            'pids' => (int) $r['pids'],
            'start_command' => $r['start_command'],
            'install_command' => $r['install_command'],
            'build_command' => $r['build_command'],
            'git_url' => $r['git_url'],
            'git_branch' => $r['git_branch'],
            'git_username' => $r['git_username'] ?? '',
            'has_git_token' => !empty($r['git_token_enc']),
            'autostart' => (bool) $r['autostart'],
            'gate_enabled' => (bool) ($r['gate_enabled'] ?? false),
            'maintenance_enabled' => (bool) ($r['maintenance_enabled'] ?? false),
            'desired_state' => $r['desired_state'],
            'lifecycle' => $r['lifecycle'],
            'created_at' => str_replace(' ', 'T', (string) $r['created_at']) . 'Z',
        ];
    }

    /** @return list<string> */
    public static function domains(int $id): array
    {
        return array_column(Db::all('SELECT domain FROM site_domains WHERE site_id = ? ORDER BY id', [$id]), 'domain');
    }

    /** @return array<string,string> */
    public static function env(int $id): array
    {
        $out = [];
        foreach (Db::all('SELECT name, value_enc FROM site_env WHERE site_id = ? ORDER BY name', [$id]) as $r) {
            $out[$r['name']] = Crypto::decrypt($r['value_enc']);
        }
        return $out;
    }

    /** @param array<string,string> $env */
    public static function setEnv(int $id, array $env): void
    {
        $pdo = Db::pdo();
        $pdo->beginTransaction();
        try {
            Db::exec('DELETE FROM site_env WHERE site_id = ?', [$id]);
            foreach ($env as $k => $v) {
                Db::exec('INSERT INTO site_env (site_id, name, value_enc) VALUES (?,?,?)', [$id, $k, Crypto::encrypt($v)]);
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        // names only, never values
        Audit::log('site.env', self::siteName($id), ['names' => array_keys($env)]);
    }

    /** @param list<string> $domains */
    public static function setDomains(int $id, array $domains): void
    {
        $pdo = Db::pdo();
        $pdo->beginTransaction();
        try {
            Db::exec('DELETE FROM site_domains WHERE site_id = ?', [$id]);
            foreach ($domains as $d) {
                Db::exec('INSERT INTO site_domains (site_id, domain) VALUES (?,?)', [$id, $d]);
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        Audit::log('site.domains', self::siteName($id), ['domains' => $domains]);
    }
}
