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

final class SystemApi
{
    /** Unauthenticated liveness probe for container/installer health checks (reveals nothing). */
    public static function health(Request $req): never
    {
        try {
            Db::val('SELECT 1');
        } catch (\Throwable) {
            header('Content-Type: text/plain');
            http_response_code(503);
            echo "db unavailable\n";
            exit;
        }
        header('Content-Type: text/plain');
        echo "ok\n";
        exit;
    }

    public static function system(Request $req): never
    {
        $components = [];
        try {
            Db::val('SELECT 1');
            $components['database'] = ['ok' => true];
        } catch (\Throwable $e) {
            $components['database'] = ['ok' => false, 'detail' => 'Database not reachable'];
        }
        $sys = null;
        try {
            $sys = Agent::get('/v1/system', 20);
            $components['agent'] = ['ok' => true];
            $components['docker'] = ['ok' => (bool) ($sys['docker']['ok'] ?? false), 'detail' => $sys['docker']['version'] ?? null];
            $svc = [];
            foreach ($sys['services'] ?? [] as $s) {
                $svc[$s['name']] = $s;
            }
            $components['proxy'] = ['ok' => ($svc['wm-proxy']['state'] ?? '') === 'running', 'detail' => $svc['wm-proxy']['status'] ?? 'unknown'];
        } catch (HttpException $e) {
            $components['agent'] = ['ok' => false, 'detail' => $e->getMessage()];
        }
        $hb = Db::val("SELECT v FROM settings WHERE k = 'worker_heartbeat'");
        $age = $hb ? time() - strtotime((string) $hb) : null;
        $components['worker'] = ['ok' => $age !== null && $age < 60, 'detail' => $age === null ? 'no sign of life' : "sign of life {$age}s ago"];
        $queued = (int) Db::val("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')");
        Response::json([
            'version' => WM_VERSION,
            'components' => $components,
            'system' => $sys,
            'jobs_active' => $queued,
            'settings' => self::settings(),
        ]);
    }

    /** @return array<string,mixed> */
    private static function settings(): array
    {
        $rows = Db::all("SELECT k, v FROM settings WHERE k IN ('dashboard_domain','acme_email')");
        $m = array_column($rows, 'v', 'k');
        return [
            'dashboard_domain' => $m['dashboard_domain'] ?? '',
            'acme_email' => $m['acme_email'] ?? '',
            'dashboard_cert' => Db::one("SELECT * FROM certificates WHERE name = 'dashboard'"),
        ];
    }

    public static function setDashboardDomain(Request $req): never
    {
        $in = $req->json();
        $domain = trim((string) ($in['domain'] ?? ''));
        $email = trim((string) ($in['email'] ?? ''));
        if ($domain !== '') {
            $domain = SiteService::normalizeDomain($domain);
            if (Db::val('SELECT id FROM site_domains WHERE domain = ?', [$domain])) {
                throw new HttpException(422, 'This domain is already assigned to a website.');
            }
        }
        $withCert = !empty($in['issue_certificate']);
        if ($withCert) {
            if ($domain === '') {
                throw new HttpException(422, 'A domain is required for a certificate.');
            }
            if (empty($in['accept_tos'])) {
                throw new HttpException(422, 'The Let\'s Encrypt terms of service must be accepted.');
            }
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                throw new HttpException(422, 'Please enter a valid contact email address.');
            }
            Db::exec("REPLACE INTO settings (k, v) VALUES ('acme_email', ?)", [$email]);
        }
        Db::exec("REPLACE INTO settings (k, v) VALUES ('dashboard_domain', ?)", [$domain]);
        Audit::log('settings.dashboard_domain', 'dashboard', ['domain' => $domain, 'certificate' => $withCert]);
        $job = $withCert
            ? JobQueue::enqueue('dashboard.cert', null, 'Set up dashboard domain and HTTPS', ['domain' => $domain, 'email' => $email])
            : JobQueue::enqueue('dashboard.domain', null, 'Set dashboard domain', ['domain' => $domain]);
        Response::json(['job' => $job]);
    }

    /** @return array<string,mixed> */
    private static function loginPolicy(): array
    {
        $policy = Auth::twoFactorPolicy();
        $roles = $policy === 'all' ? ['viewer', 'operator', 'admin'] : ($policy === 'admins' ? ['admin'] : []);
        $without = 0;
        if ($roles) {
            $marks = implode(',', array_fill(0, count($roles), '?'));
            $without = (int) Db::val("SELECT COUNT(*) FROM users WHERE active = 1 AND totp_enabled = 0 AND NOT EXISTS (SELECT 1 FROM user_passkeys p WHERE p.user_id = users.id) AND role IN ($marks)", $roles);
        }
        return ['require_2fa' => $policy, 'without_2fa' => $without, 'public_url' => trim((string) Db::val("SELECT v FROM settings WHERE k = 'public_url'"))];
    }

    /** Public address of the dashboard (passkeys are bound to its domain). Empty = derived from the request. */
    public static function setPublicUrl(Request $req): never
    {
        $url = rtrim(trim((string) ($req->json()['public_url'] ?? '')), '/');
        if ($url !== '' && !preg_match('#^(https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?|http://localhost(:[0-9]{1,5})?)$#', $url)) {
            throw new HttpException(422, 'The public address must have the form https://panel.example.com (without a path).');
        }
        Db::exec("REPLACE INTO settings (k, v) VALUES ('public_url', ?)", [$url]);
        Audit::log('settings.public_url', $url);
        Response::json(self::loginPolicy());
    }

    public static function loginSettings(Request $req): never
    {
        Response::json(self::loginPolicy());
    }

    public static function setLoginSettings(Request $req): never
    {
        $policy = (string) ($req->json()['require_2fa'] ?? '');
        if (!in_array($policy, ['off', 'admins', 'all'], true)) {
            throw new HttpException(422, 'Invalid selection.');
        }
        $me = Auth::user();
        if (Auth::policyCovers($policy, (string) $me['role']) && !Auth::hasSecondFactor((int) $me['id'])) {
            throw new HttpException(422, 'Set up your own two-factor authentication under “My account” first, otherwise you lock yourself out.');
        }
        Db::exec("REPLACE INTO settings (k, v) VALUES ('require_2fa', ?)", [$policy]);
        Audit::log('settings.require_2fa', $policy);
        Response::json(self::loginPolicy());
    }

    public static function changePassword(Request $req): never
    {
        $in = $req->json();
        $user = Auth::user();
        $row = Db::one('SELECT password_hash FROM users WHERE id = ?', [$user['id']]);
        if (!$row || !password_verify((string) ($in['current'] ?? ''), $row['password_hash'])) {
            throw new HttpException(403, 'The current password is wrong.');
        }
        $new = (string) ($in['new'] ?? '');
        if ($err = Auth::passwordPolicyError($new)) {
            throw new HttpException(422, $err);
        }
        $hash = password_hash($new, PASSWORD_ARGON2ID);
        Db::exec('UPDATE users SET password_hash = ? WHERE id = ?', [$hash, $user['id']]);
        $_SESSION['pwf'] = Auth::pwFingerprint($hash);
        session_regenerate_id(true);
        Audit::log('auth.password_change', (string) $user['email']);
        \WebManager\Services\ConsoleGuard::endUser((int) $user['id'], 'password changed');
        Response::json(['ok' => true]);
    }

    /**
     * Search filter of the audit log: every word must appear in actor, action, target, IP or details; optional period (from/to as
     * YYYY-MM-DD, server time is UTC) and `before` (id) for paging.
     * @return array{0:string,1:list<mixed>}
     */
    private static function auditFilter(Request $req): array
    {
        $where = [];
        $args = [];
        $words = array_slice(preg_split('/\s+/', trim($req->q('q'))) ?: [], 0, 8);
        foreach ($words as $w) {
            if ($w === '') {
                continue;
            }
            $like = '%' . addcslashes(mb_substr($w, 0, 80), '%_\\') . '%';
            $where[] = '(actor LIKE ? OR action LIKE ? OR target LIKE ? OR ip LIKE ? OR CAST(details AS CHAR) LIKE ?)';
            array_push($args, $like, $like, $like, $like, $like);
        }
        $from = $req->q('from');
        if ($from !== '') {
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) || strtotime($from) === false) {
                throw new HttpException(422, 'Invalid start date.');
            }
            $where[] = 'created_at >= ?';
            $args[] = $from . ' 00:00:00';
        }
        $to = $req->q('to');
        if ($to !== '') {
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $to) || strtotime($to) === false) {
                throw new HttpException(422, 'Invalid end date.');
            }
            $where[] = 'created_at < ? + INTERVAL 1 DAY';
            $args[] = $to . ' 00:00:00';
        }
        $before = (int) $req->q('before', '0');
        if ($before > 0) {
            $where[] = 'id < ?';
            $args[] = $before;
        }
        return [$where ? 'WHERE ' . implode(' AND ', $where) : '', $args];
    }

    public static function audit(Request $req): never
    {
        $limit = max(1, min((int) $req->q('limit', '100'), 500));
        [$where, $args] = self::auditFilter($req);
        $rows = Db::all("SELECT id, actor, action, target, ip, details, created_at FROM audit_log $where ORDER BY id DESC LIMIT " . ($limit + 1), $args);
        $more = count($rows) > $limit;
        $rows = array_slice($rows, 0, $limit);
        foreach ($rows as &$r) {
            $r['created_at'] = str_replace(' ', 'T', (string) $r['created_at']) . 'Z';
        }
        unset($r);
        Response::json(['entries' => $rows, 'more' => $more]);
    }

    /** CSV export of the (filtered) audit log, newest first, at most 20000 entries. */
    public static function auditExport(Request $req): never
    {
        [$where, $args] = self::auditFilter($req);
        $rows = Db::all("SELECT created_at, actor, action, target, ip, details FROM audit_log $where ORDER BY id DESC LIMIT 20000", $args);
        Audit::log('audit.export', 'audit_log', ['rows' => count($rows)]);
        // a cell that starts with = + - @ would be run as a formula by spreadsheet programs
        $cell = static function (mixed $v): string {
            $v = (string) $v;
            if ($v !== '' && strpbrk($v[0], "=+-@\t\r") !== false) {
                $v = "'" . $v;
            }
            return '"' . str_replace('"', '""', $v) . '"';
        };
        http_response_code(200);
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="audit-log-' . gmdate('Ymd-His') . '.csv"');
        header('Cache-Control: no-store');
        echo "\xEF\xBB\xBF" . implode(',', ['"Time (UTC)"', '"User"', '"Action"', '"Target"', '"IP"', '"Details"']) . "\r\n";
        foreach ($rows as $r) {
            echo implode(',', array_map($cell, [$r['created_at'], $r['actor'], $r['action'], $r['target'], $r['ip'], $r['details']])) . "\r\n";
        }
        exit;
    }

    public static function renewCerts(Request $req): never
    {
        $job = JobQueue::enqueue('certs.renew', null, 'Check and renew certificates');
        Audit::log('certs.renew', 'all');
        Response::json(['job' => $job]);
    }

    public static function reconcile(Request $req): never
    {
        $job = JobQueue::enqueue('system.reconcile', null, 'Reconcile websites and proxy');
        Audit::log('system.reconcile', 'all');
        Response::json(['job' => $job]);
    }
}
