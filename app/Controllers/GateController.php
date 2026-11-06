<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Support\Audit;
use WebManager\Support\Db;
use WebManager\Support\Env;
use WebManager\Support\View;

/**
 * Password gate for websites. The reverse proxy asks /gate/auth (auth_request) for every request of a protected site
 * and forwards /__wm_gate/* here. Sessions are stateless: an HMAC-signed cookie carrying the expiry, bound to the
 * current password (changing the password signs everybody out). Runs without the dashboard session.
 */
final class GateController
{
    private const COOKIE = '__wm_gate';
    private const PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
    private const STATIC = [
        'widget.js' => ['gate-widget.js', 'application/javascript; charset=utf-8'],
        'gate.css' => ['gate.css', 'text/css; charset=utf-8'],
        'logo.png' => ['logo.png', 'image/png'],
    ];

    /**
     * Gate pages are served on the visitors' own domain, where none of the dashboard's assets exist.
     * Errors are therefore rendered as a small self-contained page, never with the dashboard layout.
     */
    public static function handle(Request $req): never
    {
        try {
            self::dispatch($req);
        } catch (HttpException $e) {
            self::errorPage($e->status, $e->getMessage());
        } catch (\Throwable $e) {
            error_log(sprintf('[webmanager] gate %s: %s in %s:%d', get_class($e), $e->getMessage(), $e->getFile(), $e->getLine()));
            self::errorPage(500, 'Internal error.');
        }
    }

    private static function errorPage(int $status, string $message): never
    {
        header(self::PAGE_CSP);
        Response::html(View::partial('gate_error', ['status' => $status, 'message' => $message]), $status);
    }

    private static function dispatch(Request $req): never
    {
        $name = substr($req->path, strlen('/gate/'));
        if ($name === '' || $name === false) {
            Response::redirect('/'); // somebody opened /__wm_gate/ itself
        }
        if (isset(self::STATIC[$name]) && $req->method === 'GET') {
            [$file, $type] = self::STATIC[$name];
            if ($name === 'logo.png' && ($custom = Db::one("SELECT mime, data FROM brand_assets WHERE k = 'logo'")) !== null) {
                header('Content-Type: ' . $custom['mime']);
                header('Cache-Control: public, max-age=300');
                header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox");
                echo $custom['data'];
                exit;
            }
            header('Content-Type: ' . $type);
            header('Cache-Control: public, max-age=300');
            readfile(WM_ROOT . '/public/assets/' . $file);
            exit;
        }
        $site = self::site($req);
        match ($name) {
            'maintenance' => self::maintenance($site),
            'brand-logo' => self::brandLogo($site),
            'auth' => self::auth($site),
            'login' => $req->method === 'POST' ? self::login($req, $site) : self::loginPage($req, $site, '', null),
            'logout' => self::logout($req),
            'status' => self::status($site),
            default => throw new HttpException(404, 'Not found'),
        };
    }

    /** @return array<string,mixed> */
    private static function site(Request $req): array
    {
        $siteHeader = $req->header('X-WebManager-Site');
        if (!preg_match('/^site-(\d{3,5})$/', $siteHeader, $m)) {
            throw new HttpException(404, 'Not found');
        }
        $site = Db::one('SELECT id, name, gate_enabled, gate_ttl_minutes, gate_title, gate_text, maintenance_title, maintenance_message FROM sites WHERE id = ?', [(int) $m[1]]);
        if (!$site) {
            throw new HttpException(404, 'Not found');
        }
        return $site;
    }

    private static function key(): string
    {
        return hash_hmac('sha256', 'wm-gate-v1', (string) hex2bin(Env::require('APP_KEY')), true);
    }

    private static function b64(string $s): string
    {
        return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
    }

    private static function fingerprint(string $hash): string
    {
        return substr(hash('sha256', $hash), 0, 16);
    }

    /** The cookie is bound to the password it was opened with: removing or replacing that password ends the session. */
    private static function sign(int $siteId, int $exp, int $pwId, string $hash): string
    {
        $payload = $siteId . '.' . $exp . '.' . $pwId . '.' . self::fingerprint($hash);
        return self::b64($payload) . '.' . self::b64(hash_hmac('sha256', $payload, self::key(), true));
    }

    /** Expiry timestamp of a valid cookie, otherwise null. @param array<string,mixed> $site */
    private static function expiry(array $site): ?int
    {
        $c = $_COOKIE[self::COOKIE] ?? '';
        if (!is_string($c) || substr_count($c, '.') !== 1) {
            return null;
        }
        [$p, $s] = explode('.', $c);
        $payload = base64_decode(strtr($p, '-_', '+/'), true);
        if ($payload === false || !hash_equals(self::b64(hash_hmac('sha256', $payload, self::key(), true)), $s)) {
            return null;
        }
        $parts = explode('.', $payload);
        if (count($parts) !== 4 || (int) $parts[0] !== (int) $site['id'] || (int) $parts[1] <= time()) {
            return null;
        }
        $hash = Db::val('SELECT password_hash FROM site_gate_passwords WHERE id = ? AND site_id = ?', [(int) $parts[2], (int) $site['id']]);
        if (!is_string($hash) || !hash_equals(self::fingerprint($hash), $parts[3])) {
            return null;
        }
        return (int) $parts[1];
    }

    private static function setCookie(Request $req, string $value, int $expires): void
    {
        setcookie(self::COOKIE, $value, [
            'expires' => $expires, 'path' => '/', 'secure' => $req->isHttps(), 'httponly' => true, 'samesite' => 'Lax',
        ]);
    }

    /** @param array<string,mixed> $site */
    private static function auth(array $site): never
    {
        $allowed = !(int) $site['gate_enabled'] || self::expiry($site) !== null;
        http_response_code($allowed ? 204 : 401);
        exit;
    }

    /** @param array<string,mixed> $site */
    private static function status(array $site): never
    {
        $exp = self::expiry($site);
        Response::json(['active' => $exp !== null, 'remaining' => $exp === null ? 0 : $exp - time()]);
    }

    /** Only local absolute paths outside the gate namespace are valid redirect targets. */
    private static function safeNext(string $next): string
    {
        if ($next === '' || $next[0] !== '/' || str_starts_with($next, '//') || str_contains($next, '\\')
            || preg_match('/[\x00-\x1f\x7f]/', $next) || str_starts_with($next, '/__wm_gate')) {
            return '/';
        }
        return $next;
    }

    /** @param array<string,mixed> $site */
    private static function loginPage(Request $req, array $site, string $error, ?string $next): never
    {
        $next ??= self::safeNext($req->header('X-WebManager-Orig-URI'));
        $html = View::partial('gate_login', [
            'error' => $error, 'next' => $next, 'title' => $site['gate_title'], 'text' => $site['gate_text'],
            'logo' => (bool) Db::val('SELECT 1 FROM site_gate_logo WHERE site_id = ?', [(int) $site['id']]),
        ]);
        header('Content-Security-Policy: ' . self::PAGE_CSP);
        Response::html($html, 401);
    }

    /** @param array<string,mixed> $site */
    private static function login(Request $req, array $site): never
    {
        $origin = $req->header('Origin');
        if ($origin !== '') {
            $oh = parse_url($origin, PHP_URL_HOST);
            $host = parse_url('http://' . ($req->header('X-Forwarded-Host') ?: $req->header('Host')), PHP_URL_HOST);
            if (!is_string($oh) || !is_string($host) || strcasecmp($oh, $host) !== 0) {
                throw new HttpException(403, 'Request from a foreign origin rejected.');
            }
        }
        $next = self::safeNext($req->post('next'));
        $pws = Db::all('SELECT id, password_hash FROM site_gate_passwords WHERE site_id = ? ORDER BY id', [(int) $site['id']]);
        if (!(int) $site['gate_enabled'] || !$pws) {
            Response::redirect($next);
        }
        $slug = sprintf('site-%03d', (int) $site['id']);
        $tag = 'gate:' . $slug;
        $ip = $req->ip();
        $fails = (int) Db::val('SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND email = ? AND success = 0 AND created_at > NOW() - INTERVAL 15 MINUTE', [$ip, $tag]);
        if ($fails >= 8) {
            Audit::log('gate.locked', $slug, ['ip' => $ip], null);
            self::loginPage($req, $site, 'Too many failed attempts. Please try again in 15 minutes.', $next);
        }
        $given = $req->post('password');
        $match = null;
        foreach ($pws as $pw) {
            if (password_verify($given, (string) $pw['password_hash'])) {
                $match = $pw;
                break;
            }
        }
        $ok = $match !== null;
        Db::exec('INSERT INTO login_attempts (ip, email, success) VALUES (?, ?, ?)', [$ip, $tag, $ok ? 1 : 0]);
        if (!$ok) {
            Audit::log('gate.failed', $slug, ['ip' => $ip], null);
            self::loginPage($req, $site, 'The password is wrong.', $next);
        }
        $exp = time() + max(1, (int) $site['gate_ttl_minutes']) * 60;
        self::setCookie($req, self::sign((int) $site['id'], $exp, (int) $match['id'], (string) $match['password_hash']), $exp);
        Response::redirect($next);
    }

    /** @param array<string,mixed> $site */
    private static function maintenance(array $site): never
    {
        header('Content-Security-Policy: ' . self::PAGE_CSP);
        header('Retry-After: 600');
        Response::html(View::partial('gate_maintenance', [
            'title' => $site['maintenance_title'], 'message' => $site['maintenance_message'],
            'logo' => (bool) Db::val('SELECT 1 FROM site_gate_logo WHERE site_id = ?', [(int) $site['id']]),
        ]), 503);
    }

    /** @param array<string,mixed> $site */
    private static function brandLogo(array $site): never
    {
        $row = Db::one('SELECT mime, data FROM site_gate_logo WHERE site_id = ?', [(int) $site['id']]);
        if (!$row) {
            throw new HttpException(404, 'Not found');
        }
        header('Content-Type: ' . $row['mime']);
        header('Cache-Control: public, max-age=300');
        header("Content-Security-Policy: default-src 'none'");
        echo $row['data'];
        exit;
    }

    private static function logout(Request $req): never
    {
        self::setCookie($req, '', time() - 3600);
        Response::json(['ok' => true]);
    }
}
