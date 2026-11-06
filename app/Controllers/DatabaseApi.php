<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\Agent;
use WebManager\Services\JobQueue;
use WebManager\Services\SiteService;
use WebManager\Support\Audit;
use WebManager\Support\Crypto;
use WebManager\Support\Db;

/** Optional database per website. Nothing exists until an operator switches it on. */
final class DatabaseApi
{
    private static function id(array $p): int
    {
        $id = filter_var($p['id'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 40000]]);
        if ($id === false) {
            throw new HttpException(404, 'Website not found');
        }
        return (int) $id;
    }

    /** @return array<string,array{label:string,image:string,port:int}> */
    private static function engines(): array
    {
        $doc = json_decode((string) file_get_contents(WM_ROOT . '/templates/runtimes.json'), true, 512, JSON_THROW_ON_ERROR);
        return $doc['databases'] ?? [];
    }

    private static function secret(int $len = 32): string
    {
        $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        $out = '';
        for ($i = 0; $i < $len; $i++) {
            $out .= $chars[random_int(0, strlen($chars) - 1)];
        }
        return $out;
    }

    public static function show(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $engines = self::engines();
        $engine = (string) ($site['db_engine'] ?? '');
        $status = ['exists' => false];
        $dumps = [];
        $unreachable = false;
        try {
            $st = Agent::get("/v1/sites/$id/database");
            $dumps = $st['dumps'] ?? [];
            unset($st['dumps']);
            $status = $st;
        } catch (HttpException) {
            $unreachable = true;
        }
        Response::json([
            'available' => array_map(static fn ($k, $v) => ['key' => $k, 'label' => $v['label']], array_keys($engines), $engines),
            'enabled' => (bool) $site['db_enabled'],
            'has_data' => $engine !== '',
            'engine' => $engine !== '' ? $engine : null,
            'engine_label' => $engines[$engine]['label'] ?? null,
            'name' => $site['db_name'], 'user' => $site['db_user'],
            'host' => 'wm-db-' . SiteService::siteName($id), 'port' => $engines[$engine]['port'] ?? null,
            'memory_mb' => (int) $site['db_memory_mb'],
            'external' => (bool) $site['db_external'],
            'external_allow' => preg_split('/\s+/', trim((string) $site['db_external_allow']), -1, PREG_SPLIT_NO_EMPTY) ?: [],
            'external_port' => $id <= 32000 ? 33000 + $id : null,
            'your_ip' => $req->ip(),
            'admin' => $status['admin'] ?? ['running' => false],
            'env_vars' => ['DB_CONNECTION', 'DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD', 'DATABASE_URL'],
            'status' => $status, 'dumps' => $dumps, 'agent_unreachable' => $unreachable,
            'busy' => JobQueue::hasActive($id),
        ]);
    }

    public static function update(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $in = $req->json();
        $enable = !empty($in['enabled']);
        $mem = filter_var($in['memory_mb'] ?? $site['db_memory_mb'], FILTER_VALIDATE_INT, ['options' => ['min_range' => 128, 'max_range' => 8192]]);
        if ($mem === false) {
            throw new HttpException(422, 'Database memory: 128–8192 MB.');
        }
        $current = (string) ($site['db_engine'] ?? '');
        if ($enable) {
            if ($site['lifecycle'] !== 'ready') {
                throw new HttpException(409, 'The website is not ready yet.');
            }
            $engine = (string) ($in['engine'] ?? $current);
            if (!isset(self::engines()[$engine])) {
                throw new HttpException(422, 'Please choose a database type.');
            }
            if ($current !== '' && $current !== $engine) {
                throw new HttpException(409, 'The type can only be changed after the database and its data have been deleted.');
            }
            if ($current === '') {
                Db::exec(
                    'UPDATE sites SET db_engine = ?, db_name = ?, db_user = ?, db_password_enc = ?, db_root_enc = ? WHERE id = ?',
                    [$engine, 'app', 'app', Crypto::encrypt(self::secret()), $engine === 'mariadb' ? Crypto::encrypt(self::secret()) : null, $id]
                );
            }
        }
        Db::exec('UPDATE sites SET db_enabled = ?, db_memory_mb = ? WHERE id = ?', [$enable ? 1 : 0, $mem, $id]);
        Audit::log($enable ? 'site.db_enable' : 'site.db_disable', SiteService::siteName($id), ['engine' => $current !== '' ? $current : ($in['engine'] ?? '')]);
        $job = JobQueue::enqueue('site.apply', $id, ($enable ? 'Set up the database of “' : 'Stop the database container of “') . $site['name'] . '”', ['restart' => false]);
        Response::json(['job' => $job]);
    }

    /** Access from outside: only addresses on the list get through (the agent runs an allowlisting forwarder). */
    public static function external(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $in = $req->json();
        if (empty($site['db_engine'])) {
            throw new HttpException(409, 'No database is set up.');
        }
        $on = !empty($in['enabled']);
        $parts = is_array($in['allow'] ?? null) ? $in['allow'] : (preg_split('/[\s,]+/', (string) ($in['allow'] ?? ''), -1, PREG_SPLIT_NO_EMPTY) ?: []);
        $allow = [];
        foreach ($parts as $item) {
            $item = trim((string) $item);
            $bits = explode('/', $item);
            $kind = filter_var($bits[0], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) ? 4 : (filter_var($bits[0], FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) ? 6 : 0);
            $ok = $kind !== 0 && count($bits) <= 2;
            if ($ok && count($bits) === 2) {
                $ok = preg_match('/^[0-9]{1,3}$/', $bits[1]) === 1 && (int) $bits[1] <= ($kind === 4 ? 32 : 128);
            }
            if (!$ok) {
                throw new HttpException(422, 'Invalid IP address or network: ' . mb_substr($item, 0, 60));
            }
            // not only the literal 0.0.0.0/0: any base address with a prefix that short (10.0.0.0/0, 0.0.0.0/1 ...) opens up half the internet or more
            if (count($bits) === 2 && (int) $bits[1] < ($kind === 4 ? 8 : 16)) {
                throw new HttpException(422, 'Such a large network is not allowed (at least /8 for IPv4, /16 for IPv6). Please enter specific addresses or networks.');
            }
            $allow[] = $item;
        }
        $allow = array_values(array_unique($allow));
        if ($on && !$allow) {
            throw new HttpException(422, 'Please enter at least one allowed address (e.g. your PC’s).');
        }
        if ($on && $id > 32000) {
            throw new HttpException(422, 'External access is only possible for websites up to number 32000.');
        }
        if (count($allow) > 50) {
            throw new HttpException(422, 'At most 50 entries.');
        }
        Db::exec('UPDATE sites SET db_external = ?, db_external_allow = ? WHERE id = ?', [$on ? 1 : 0, implode("\n", $allow), $id]);
        Audit::log($on ? 'site.db_external_on' : 'site.db_external_off', SiteService::siteName($id), ['allow' => count($allow)]);
        Response::json(['job' => JobQueue::enqueue('site.apply', $id, 'Apply external database access for “' . $site['name'] . '”', ['restart' => false])]);
    }

    /** Starts the web administration (Adminer) for this website's database. */
    public static function manage(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        if (!$site['db_enabled'] || empty($site['db_engine'])) {
            throw new HttpException(409, 'The database is not active.');
        }
        Audit::log('site.db_manage', SiteService::siteName($id));
        Response::json(['job' => JobQueue::enqueue('db.admin.start', $id, 'Start database management of “' . $site['name'] . '”')]);
    }

    public static function manageStop(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        Response::json(['job' => JobQueue::enqueue('db.admin.stop', $id, 'End database management of “' . $site['name'] . '”')]);
    }

    /**
     * Called by the reverse proxy (auth_request) for every request to /dbadmin/site-NNN/…:
     * 204 = signed-in operator, anything else is refused. Roles are enforced by the central permission check.
     */
    public static function adminAuth(Request $req): never
    {
        if (!preg_match('#^/dbadmin/site-(\d{3,5})(?:[/?]|$)#', $req->header('X-Original-URI'), $m) || !Db::val('SELECT 1 FROM sites WHERE id = ?', [(int) $m[1]])) {
            throw new HttpException(403, 'Not allowed');
        }
        http_response_code(204);
        exit;
    }

    /** Shows the password only on explicit request; every reveal is logged. */
    public static function password(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        if (empty($site['db_password_enc'])) {
            throw new HttpException(404, 'No database present.');
        }
        Audit::log('site.db_password_view', SiteService::siteName($id));
        Response::json(['password' => Crypto::decrypt((string) $site['db_password_enc'])]);
    }

    public static function rotate(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        Audit::log('site.db_rotate', SiteService::siteName($id));
        Response::json(['job' => JobQueue::enqueue('db.rotate', $id, 'Renew the database password of “' . $site['name'] . '”')]);
    }

    public static function dump(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        Response::json(['job' => JobQueue::enqueue('db.dump', $id, 'Create database dump of “' . $site['name'] . '”')]);
    }

    public static function download(Request $req, array $p): never
    {
        $id = self::id($p);
        SiteService::row($id);
        $name = (string) ($p['name'] ?? '');
        if (!preg_match('/^db-\d{8}-\d{6}\.sql\.gz$/', $name)) {
            throw new HttpException(404, 'Dump not found');
        }
        Audit::log('site.db_dump_download', SiteService::siteName($id), ['file' => $name]);
        Agent::download("/v1/sites/$id/database/dumps/$name", $name);
    }

    public static function deleteDump(Request $req, array $p): never
    {
        $id = self::id($p);
        SiteService::row($id);
        $name = (string) ($p['name'] ?? '');
        if (!preg_match('/^db-\d{8}-\d{6}\.sql\.gz$/', $name)) {
            throw new HttpException(404, 'Dump not found');
        }
        Response::json(Agent::request('DELETE', "/v1/sites/$id/database/dumps/$name"));
    }

    public static function restore(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $in = $req->json();
        $name = (string) ($in['name'] ?? '');
        if (!preg_match('/^db-\d{8}-\d{6}\.sql\.gz$/', $name)) {
            throw new HttpException(422, 'Invalid dump name.');
        }
        if (empty($in['confirm'])) {
            throw new HttpException(422, 'Please confirm the restore.');
        }
        Audit::log('site.db_restore', SiteService::siteName($id), ['file' => $name]);
        Response::json(['job' => JobQueue::enqueue('db.restore', $id, 'Restore the database of “' . $site['name'] . '” from ' . $name, ['name' => $name])]);
    }

    public static function purge(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        if (($req->json()['confirm'] ?? '') !== $site['name']) {
            throw new HttpException(422, 'To confirm, the website name must be entered exactly.');
        }
        Audit::log('site.db_purge', SiteService::siteName($id));
        Response::json(['job' => JobQueue::enqueue('db.purge', $id, 'Delete the database of “' . $site['name'] . '” permanently')]);
    }
}
