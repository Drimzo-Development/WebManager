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
use WebManager\Support\Db;

/** Access control in front of a website: password gate (several passwords, public paths, own login page) and maintenance mode. */
final class AccessApi
{
    private const MAX_PASSWORDS = 10;
    private const MAX_LOGO_BYTES = 512 * 1024;

    private static function id(array $p): int
    {
        $id = filter_var($p['id'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 40000]]);
        if ($id === false) {
            throw new HttpException(404, 'Website not found');
        }
        return (int) $id;
    }

    private static function apply(int $id, array $site, string $what): int
    {
        return JobQueue::enqueue('site.apply', $id, 'Apply ' . $what . ' of “' . $site['name'] . '”', ['restart' => false]);
    }

    /** @return list<string> */
    private static function lines(mixed $v): array
    {
        $parts = is_array($v) ? $v : (preg_split('/[\s,]+/', (string) $v, -1, PREG_SPLIT_NO_EMPTY) ?: []);
        return array_values(array_unique(array_map('trim', array_map('strval', $parts))));
    }

    // ------------------------------------------------------------------ password gate

    public static function getGate(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $pw = Db::all('SELECT id, label, created_at FROM site_gate_passwords WHERE site_id = ? ORDER BY id', [$id]);
        Response::json([
            'enabled' => (bool) $site['gate_enabled'],
            'ttl_minutes' => (int) $site['gate_ttl_minutes'],
            'title' => $site['gate_title'],
            'text' => $site['gate_text'],
            'bypass_paths' => self::lines($site['gate_bypass_paths']),
            'has_logo' => (bool) Db::val('SELECT 1 FROM site_gate_logo WHERE site_id = ?', [$id]),
            'passwords' => array_map(static fn ($r) => ['id' => (int) $r['id'], 'label' => $r['label'], 'created_at' => str_replace(' ', 'T', (string) $r['created_at']) . 'Z'], $pw),
            'max_passwords' => self::MAX_PASSWORDS,
        ]);
    }

    public static function putGate(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $in = $req->json();
        $enabled = !empty($in['enabled']);
        $ttl = filter_var($in['ttl_minutes'] ?? 480, FILTER_VALIDATE_INT, ['options' => ['min_range' => 5, 'max_range' => 43200]]);
        if ($ttl === false) {
            throw new HttpException(422, 'Validity: 5 minutes to 30 days.');
        }
        $title = trim((string) ($in['title'] ?? ''));
        $text = trim((string) ($in['text'] ?? ''));
        if (mb_strlen($title) > 150 || mb_strlen($text) > 500) {
            throw new HttpException(422, 'Title: at most 150, text: at most 500 characters.');
        }
        $paths = self::lines($in['bypass_paths'] ?? []);
        if (count($paths) > 20) {
            throw new HttpException(422, 'At most 20 path exceptions.');
        }
        foreach ($paths as $path) {
            if (!preg_match('#^/[A-Za-z0-9_\-./]{1,100}$#', $path) || str_contains($path, '..') || str_contains($path, '//')) {
                throw new HttpException(422, 'Invalid path: ' . mb_substr($path, 0, 60) . ' (allowed: letters, digits, _ - . /)');
            }
        }
        if ($enabled && !Db::val('SELECT 1 FROM site_gate_passwords WHERE site_id = ?', [$id])) {
            throw new HttpException(422, 'Please create at least one password first.');
        }
        Db::exec(
            'UPDATE sites SET gate_enabled = ?, gate_ttl_minutes = ?, gate_title = ?, gate_text = ?, gate_bypass_paths = ? WHERE id = ?',
            [$enabled ? 1 : 0, $ttl, $title, $text, implode("\n", $paths), $id]
        );
        Audit::log('site.gate', SiteService::siteName($id), ['enabled' => $enabled, 'ttl_minutes' => $ttl, 'bypass' => count($paths)]);
        Response::json(['job' => self::apply($id, $site, 'password protection')]);
    }

    public static function addPassword(Request $req, array $p): never
    {
        $id = self::id($p);
        SiteService::row($id);
        $in = $req->json();
        $label = trim((string) ($in['label'] ?? ''));
        $password = (string) ($in['password'] ?? '');
        if (mb_strlen($label) > 100) {
            throw new HttpException(422, 'Label: at most 100 characters.');
        }
        if (mb_strlen($password) < 8 || mb_strlen($password) > 200) {
            throw new HttpException(422, 'The password must be 8 to 200 characters long.');
        }
        if ((int) Db::val('SELECT COUNT(*) FROM site_gate_passwords WHERE site_id = ?', [$id]) >= self::MAX_PASSWORDS) {
            throw new HttpException(422, 'At most ' . self::MAX_PASSWORDS . ' passwords per website.');
        }
        $pid = Db::insert(
            'INSERT INTO site_gate_passwords (site_id, label, password_hash) VALUES (?, ?, ?)',
            [$id, $label, password_hash($password, PASSWORD_ARGON2ID)]
        );
        Audit::log('site.gate_password_add', SiteService::siteName($id), ['label' => $label]);
        Response::json(['id' => $pid], 201);
    }

    public static function deletePassword(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $pid = (int) ($p['pid'] ?? 0);
        $row = Db::one('SELECT id, label FROM site_gate_passwords WHERE id = ? AND site_id = ?', [$pid, $id]);
        if (!$row) {
            throw new HttpException(404, 'Password not found');
        }
        $left = (int) Db::val('SELECT COUNT(*) FROM site_gate_passwords WHERE site_id = ? AND id <> ?', [$id, $pid]);
        if ($left === 0 && (int) $site['gate_enabled'] === 1) {
            throw new HttpException(409, 'The last password cannot be deleted while the protection is on.');
        }
        // sessions that were opened with this password end immediately (the cookie is bound to the password)
        Db::exec('DELETE FROM site_gate_passwords WHERE id = ?', [$pid]);
        Audit::log('site.gate_password_delete', SiteService::siteName($id), ['label' => $row['label']]);
        Response::json(['ok' => true]);
    }

    public static function putLogo(Request $req, array $p): never
    {
        $id = self::id($p);
        SiteService::row($id);
        $f = $_FILES['logo'] ?? null;
        if (!is_array($f) || ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file((string) $f['tmp_name'])) {
            throw new HttpException(422, 'Please choose an image file.');
        }
        if ((int) $f['size'] > self::MAX_LOGO_BYTES) {
            throw new HttpException(422, 'The logo may be at most 512 KB.');
        }
        $data = (string) file_get_contents((string) $f['tmp_name']);
        $info = @getimagesizefromstring($data);
        $types = [IMAGETYPE_PNG => 'image/png', IMAGETYPE_JPEG => 'image/jpeg', IMAGETYPE_WEBP => 'image/webp'];
        if ($info === false || !isset($types[$info[2]]) || $info[0] > 4000 || $info[1] > 4000) {
            throw new HttpException(422, 'PNG, JPEG and WebP up to 4000 × 4000 pixels are allowed.');
        }
        Db::exec('REPLACE INTO site_gate_logo (site_id, mime, data) VALUES (?, ?, ?)', [$id, $types[$info[2]], $data]);
        Audit::log('site.gate_logo', SiteService::siteName($id));
        Response::json(['ok' => true]);
    }

    public static function deleteLogo(Request $req, array $p): never
    {
        $id = self::id($p);
        SiteService::row($id);
        Db::exec('DELETE FROM site_gate_logo WHERE site_id = ?', [$id]);
        Response::json(['ok' => true]);
    }

    // ------------------------------------------------------------------ maintenance mode

    public static function getMaintenance(Request $req, array $p): never
    {
        $site = SiteService::row(self::id($p));
        Response::json([
            'enabled' => (bool) $site['maintenance_enabled'],
            'title' => $site['maintenance_title'],
            'message' => $site['maintenance_message'],
            'allow_ips' => self::lines($site['maintenance_allow_ips']),
            'your_ip' => $req->ip(),
        ]);
    }

    public static function putMaintenance(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $in = $req->json();
        $title = trim((string) ($in['title'] ?? ''));
        $message = trim((string) ($in['message'] ?? ''));
        if (mb_strlen($title) > 150 || mb_strlen($message) > 1000) {
            throw new HttpException(422, 'Title: at most 150, text: at most 1000 characters.');
        }
        $ips = self::lines($in['allow_ips'] ?? []);
        if (count($ips) > 20) {
            throw new HttpException(422, 'At most 20 IP addresses.');
        }
        foreach ($ips as $ip) {
            if (!filter_var($ip, FILTER_VALIDATE_IP)) {
                throw new HttpException(422, 'Invalid IP address: ' . mb_substr($ip, 0, 60));
            }
        }
        $enabled = !empty($in['enabled']);
        Db::exec(
            'UPDATE sites SET maintenance_enabled = ?, maintenance_title = ?, maintenance_message = ?, maintenance_allow_ips = ? WHERE id = ?',
            [$enabled ? 1 : 0, $title, $message, implode("\n", $ips), $id]
        );
        Audit::log('site.maintenance', SiteService::siteName($id), ['enabled' => $enabled]);
        Response::json(['job' => self::apply($id, $site, 'maintenance mode')]);
    }

    // ------------------------------------------------------------------ security headers and WAF

    private const WAF_CATEGORIES = [
        'sqli' => 'SQL injection', 'xss' => 'Cross-site scripting (XSS)', 'traversal' => 'Path traversal and file inclusion',
        'rce' => 'Command injection', 'probe' => 'Access to sensitive files (.env, .git, phpMyAdmin …)', 'scanner' => 'Security scanners (user agent)',
    ];
    private const HEADER_DEFAULTS = ['hsts' => false, 'xfo' => 'off', 'nosniff' => false, 'referrer' => 'off', 'permissions' => false, 'csp' => '', 'cspReportOnly' => false];

    public static function getSecurity(Request $req, array $p): never
    {
        $site = SiteService::row(self::id($p));
        $h = is_string($site['sec_headers']) && $site['sec_headers'] !== '' ? (json_decode($site['sec_headers'], true) ?: []) : [];
        Response::json([
            'headers' => array_replace(self::HEADER_DEFAULTS, $h),
            'waf_mode' => $site['waf_mode'],
            'waf_categories' => self::lines($site['waf_categories']),
            'waf_exempt' => self::lines($site['waf_exempt']),
            'waf_labels' => self::WAF_CATEGORIES,
        ]);
    }

    public static function putSecurity(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $in = $req->json();
        $h = is_array($in['headers'] ?? null) ? $in['headers'] : [];
        $headers = [
            'hsts' => !empty($h['hsts']),
            'xfo' => in_array($xfo = (string) ($h['xfo'] ?? 'off'), ['off', 'sameorigin', 'deny'], true) ? $xfo : 'off',
            'nosniff' => !empty($h['nosniff']),
            'referrer' => in_array($ref = (string) ($h['referrer'] ?? 'off'), ['off', 'no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'], true) ? $ref : 'off',
            'permissions' => !empty($h['permissions']),
            'csp' => trim((string) ($h['csp'] ?? '')),
            'cspReportOnly' => !empty($h['cspReportOnly']),
        ];
        if (!preg_match('/^[A-Za-z0-9 ;:\'\-_.*\/=,+%?&#!~()]{0,1500}$/', $headers['csp'])) {
            throw new HttpException(422, 'The Content-Security-Policy contains invalid characters (no quotation marks except \', no $ or \\, no line breaks).');
        }
        $mode = (string) ($in['waf_mode'] ?? 'off');
        if (!in_array($mode, ['off', 'detect', 'block'], true)) {
            throw new HttpException(422, 'Unknown WAF mode.');
        }
        $cats = array_values(array_intersect(array_keys(self::WAF_CATEGORIES), self::lines($in['waf_categories'] ?? [])));
        if ($mode !== 'off' && !$cats) {
            throw new HttpException(422, 'Please choose at least one WAF category.');
        }
        $exempt = self::lines($in['waf_exempt'] ?? []);
        if (count($exempt) > 20) {
            throw new HttpException(422, 'At most 20 WAF exceptions.');
        }
        foreach ($exempt as $path) {
            if (!preg_match('#^/[A-Za-z0-9_\-./]{1,100}$#', $path) || str_contains($path, '..') || str_contains($path, '//')) {
                throw new HttpException(422, 'Invalid path: ' . mb_substr($path, 0, 60));
            }
        }
        Db::exec(
            'UPDATE sites SET sec_headers = ?, waf_mode = ?, waf_categories = ?, waf_exempt = ? WHERE id = ?',
            [json_encode($headers, JSON_UNESCAPED_SLASHES), $mode, implode(' ', $cats), implode("\n", $exempt), $id]
        );
        Audit::log('site.security', SiteService::siteName($id), ['waf' => $mode, 'headers' => array_keys(array_filter($headers))]);
        Response::json(['job' => self::apply($id, $site, 'security settings')]);
    }

    // ------------------------------------------------------------------ IP rules and rate limit

    /** Validates "address" or "address/prefix" (IPv4 or IPv6). */
    private static function net(string $v): string
    {
        $parts = explode('/', $v);
        $ip = filter_var($parts[0], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) ? 4 : (filter_var($parts[0], FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) ? 6 : 0);
        $ok = $ip !== 0 && count($parts) <= 2;
        if ($ok && count($parts) === 2) {
            $ok = preg_match('/^[0-9]{1,3}$/', $parts[1]) === 1 && (int) $parts[1] <= ($ip === 4 ? 32 : 128);
        }
        if (!$ok) {
            throw new HttpException(422, 'Invalid IP address or network: ' . mb_substr($v, 0, 60));
        }
        return $v;
    }

    public static function getRules(Request $req, array $p): never
    {
        $site = SiteService::row(self::id($p));
        Response::json([
            'allow' => self::lines($site['ip_allow']),
            'deny' => self::lines($site['ip_deny']),
            'rate_rps' => (int) $site['rate_limit_rps'],
            'rate_burst' => (int) $site['rate_limit_burst'],
            'conn_limit' => (int) $site['conn_limit'],
            'geo_mode' => $site['geo_mode'],
            'geo_countries' => preg_split('/\s+/', trim((string) $site['geo_countries']), -1, PREG_SPLIT_NO_EMPTY) ?: [],
            'geo' => self::geoStatus(),
            'your_ip' => $req->ip(),
        ]);
    }

    /** @return array<string,mixed> */
    private static function geoStatus(): array
    {
        try {
            return Agent::get('/v1/geo');
        } catch (HttpException) {
            return ['ready' => false, 'updatedAt' => null, 'countries' => 0, 'ranges' => 0, 'unreachable' => true];
        }
    }

    /** Loads the country data (once, weekly afterwards). */
    public static function updateGeo(Request $req): never
    {
        $job = JobQueue::enqueue('geo.update', null, 'Update country data (GeoIP)');
        Audit::log('geo.update', 'geoip');
        Response::json(['job' => $job]);
    }

    public static function putRules(Request $req, array $p): never
    {
        $id = self::id($p);
        $site = SiteService::row($id);
        $in = $req->json();
        $allow = array_map([self::class, 'net'], self::lines($in['allow'] ?? []));
        $deny = array_map([self::class, 'net'], self::lines($in['deny'] ?? []));
        if (count($allow) > 100 || count($deny) > 100) {
            throw new HttpException(422, 'At most 100 entries per list.');
        }
        $rps = filter_var($in['rate_rps'] ?? 0, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 1000]]);
        $burst = filter_var($in['rate_burst'] ?? 50, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 5000]]);
        if ($rps === false || $burst === false) {
            throw new HttpException(422, 'Requests per second: 0–1000, burst: 0–5000.');
        }
        $connLimit = filter_var($in['conn_limit'] ?? 0, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 10000]]);
        if ($connLimit === false) {
            throw new HttpException(422, 'Connections per IP: 0–10000.');
        }
        $geoMode = (string) ($in['geo_mode'] ?? 'off');
        if (!in_array($geoMode, ['off', 'block', 'allow'], true)) {
            throw new HttpException(422, 'Unknown country mode.');
        }
        $countries = array_values(array_unique(array_map('strtoupper', self::lines($in['geo_countries'] ?? []))));
        foreach ($countries as $cc) {
            if (!preg_match('/^[A-Z]{2}$/', $cc)) {
                throw new HttpException(422, 'Invalid country code: ' . mb_substr($cc, 0, 10));
            }
        }
        if (count($countries) > 250) {
            throw new HttpException(422, 'Too many countries.');
        }
        if ($geoMode !== 'off' && !$countries) {
            throw new HttpException(422, 'Please choose at least one country.');
        }
        if ($geoMode !== 'off' && empty(self::geoStatus()['ready'])) {
            throw new HttpException(409, 'The country data is not loaded yet. Please run “Load country data” first and wait until the task has finished.');
        }
        Db::exec(
            'UPDATE sites SET ip_allow = ?, ip_deny = ?, rate_limit_rps = ?, rate_limit_burst = ?, conn_limit = ?, geo_mode = ?, geo_countries = ? WHERE id = ?',
            [implode("\n", $allow), implode("\n", $deny), $rps, $burst, $connLimit, $geoMode, implode(' ', $countries), $id]
        );
        Audit::log('site.rules', SiteService::siteName($id), ['allow' => count($allow), 'deny' => count($deny), 'rps' => $rps]);
        Response::json(['job' => self::apply($id, $site, 'access rules')]);
    }
}
