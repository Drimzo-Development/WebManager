<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\Auth;
use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\Agent;
use WebManager\Services\ConsoleGuard;
use WebManager\Services\SiteService;
use WebManager\Support\Audit;
use WebManager\Support\Crypto;
use WebManager\Support\Db;
use WebManager\Support\Env;
use WebManager\Support\Totp;
use WebManager\Support\View;

/**
 * Web console: an interactive shell in the container of a website. Administrators only (see Permissions), session only (no API
 * tokens). The terminal itself runs in its own page (/console/N, shown in an iframe of the dashboard) because the terminal
 * library creates style elements, which the strict content security policy of the dashboard does not allow; that page gets its own,
 * slightly relaxed policy (inline styles only, no inline scripts).
 */
final class ConsoleApi
{
    /** Host (with port) as the browser wrote it: letters, digits, dots, hyphens, colon, brackets of an IPv6 address. */
    private static function cleanHost(string $h): string
    {
        return preg_match('/^[A-Za-z0-9.\-:\[\]]{1,260}$/', $h) === 1 ? strtolower($h) : '';
    }

    /** The page with the terminal (shown in an iframe of the site's “Console” tab, or on its own). */
    public static function page(Request $req, array $p): never
    {
        $id = (int) ($p['id'] ?? 0);
        $site = SiteService::row($id);
        $host = self::cleanHost($req->header('X-Forwarded-Host') ?: $req->header('Host'));
        // the page may only be framed by the dashboard itself; the terminal library needs inline styles
        header('X-Frame-Options: SAMEORIGIN');
        header("Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
            . "connect-src 'self'" . ($host !== '' ? " ws://$host wss://$host" : '') . "; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
        Response::html(View::partial('console', [
            'siteId' => $id,
            'siteName' => (string) $site['name'],
            'csrf' => Auth::csrf(),
            'dist' => is_file(WM_ROOT . '/public/assets/console/console.js'),
        ]));
    }

    /** Default "worker": the dashboard may not ask the agent for tickets itself, the worker does it (CONSOLE_TICKETS=dashboard changes that). */
    private static function mode(): string
    {
        return strtolower((string) Env::get('CONSOLE_TICKETS', 'worker')) === 'dashboard' ? 'dashboard' : 'worker';
    }

    /** How long a password confirmation allows opening consoles. */
    private const REAUTH_SECONDS = 600;
    private const REAUTH_TRIES = 5;

    private static function reauthValid(): bool
    {
        return time() - (int) ($_SESSION['console_reauth'] ?? 0) <= self::REAUTH_SECONDS;
    }

    /**
     * Opening a shell needs the password again (and the authenticator code when the account has one), even in a valid session: a
     * stolen session cookie alone is not enough. Valid for 10 minutes; failed attempts are throttled and audited.
     */
    public static function confirm(Request $req): never
    {
        $uid = (int) (Auth::user()['id'] ?? 0);
        $in = $req->json();
        $tag = 'console:' . $uid;
        $fails = (int) Db::val('SELECT COUNT(*) FROM login_attempts WHERE email = ? AND success = 0 AND created_at > NOW() - INTERVAL 15 MINUTE', [$tag]);
        if ($fails >= self::REAUTH_TRIES) {
            Audit::log('console.reauth_locked', $tag);
            throw new HttpException(429, 'Too many failed attempts. Please try again in 15 minutes.');
        }
        $u = Db::one('SELECT id, email, password_hash, totp_enabled, totp_secret_enc, totp_last_step FROM users WHERE id = ? AND active = 1', [$uid]);
        if (!$u) {
            throw new HttpException(403, 'Not allowed');
        }
        $needsCode = (int) $u['totp_enabled'] === 1;
        $code = trim((string) ($in['code'] ?? ''));
        if ($needsCode && $code === '') {
            throw new HttpException(422, 'Please enter the code of your authenticator app.', ['needs_code' => true]);
        }
        $ok = password_verify((string) ($in['password'] ?? ''), (string) $u['password_hash']);
        if ($ok && $needsCode) {
            $step = Totp::verify(Crypto::decrypt((string) $u['totp_secret_enc']), $code, (int) $u['totp_last_step']);
            // the update only succeeds once per step, so the same code can never be used twice
            $ok = $step !== null && Db::exec('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?', [$step, $uid, $step]) === 1;
        }
        Db::exec('INSERT INTO login_attempts (ip, email, success) VALUES (?, ?, ?)', [$req->ip(), $tag, $ok ? 1 : 0]);
        if (!$ok) {
            Audit::log('console.reauth_failed', (string) $u['email']);
            throw new HttpException(403, $needsCode ? 'The password or the code is wrong.' : 'The password is wrong.', ['needs_code' => $needsCode]);
        }
        $_SESSION['console_reauth'] = time();
        Audit::log('console.reauth', (string) $u['email']);
        Response::json(['ok' => true, 'valid_for' => self::REAUTH_SECONDS]);
    }

    /** Console switch, mode and the running sessions of this website (administrators). */
    public static function settings(Request $req, array $p): never
    {
        $id = (int) ($p['id'] ?? 0);
        $site = SiteService::row($id);
        $sessions = [];
        try {
            foreach (Agent::get('/v1/console/sessions')['sessions'] ?? [] as $s) {
                if ((int) ($s['siteId'] ?? 0) === $id) {
                    $sessions[] = $s;
                }
            }
        } catch (HttpException) {
            // the agent is not reachable: the list stays empty, the switch can still be changed
        }
        Response::json(['enabled' => (int) ($site['console_enabled'] ?? 0) === 1, 'mode' => self::mode(), 'sessions' => $sessions]);
    }

    public static function saveSettings(Request $req, array $p): never
    {
        $id = (int) ($p['id'] ?? 0);
        SiteService::row($id);
        $on = !empty($req->json()['enabled']);
        Db::exec('UPDATE sites SET console_enabled = ? WHERE id = ?', [$on ? 1 : 0, $id]);
        Audit::log('site.console_setting', SiteService::siteName($id), ['enabled' => $on]);
        if (!$on) {
            ConsoleGuard::endSite($id);
        }
        Response::json(['ok' => true, 'enabled' => $on]);
    }

    /**
     * Asks for a one-time ticket; the browser then opens the WebSocket /__console and sends the ticket as subprotocol. In worker mode the answer is
     * { pending: <request id> } and the ticket is fetched with ticketResult() once the worker has produced it.
     */
    public static function ticket(Request $req, array $p): never
    {
        $id = (int) ($p['id'] ?? 0);
        $site = SiteService::row($id);
        if (($site['lifecycle'] ?? '') !== 'ready') {
            throw new HttpException(409, 'The website is not ready yet.');
        }
        if ((int) ($site['console_enabled'] ?? 0) !== 1) {
            throw new HttpException(403, 'The console is switched off for this website. Switch it on in the Console tab (“Allow the console for this website”).');
        }
        $uid = (int) (Auth::user()['id'] ?? 0);
        if (!Auth::hasSecondFactor($uid)) {
            throw new HttpException(403, 'The console needs two-factor authentication: set up an authenticator app or a passkey under “My account” first.');
        }
        if (!self::reauthValid()) {
            $needsCode = (int) Db::val('SELECT totp_enabled FROM users WHERE id = ?', [$uid]) === 1;
            throw new HttpException(403, 'Please confirm your password.', ['reauth' => true, 'needs_code' => $needsCode]);
        }
        $in = $req->json();
        $cols = filter_var($in['cols'] ?? 80, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 500, 'default' => 80]]);
        $rows = filter_var($in['rows'] ?? 24, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 300, 'default' => 24]]);
        $user = Auth::user();
        $actor = (string) ($user['email'] ?? '');
        if (self::mode() === 'worker') {
            $rid = bin2hex(random_bytes(16));
            Db::exec(
                'INSERT INTO console_requests (id, user_id, site_id, actor, term_cols, term_rows, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
                [$rid, (int) ($user['id'] ?? 0), $id, mb_substr($actor, 0, 190), $cols, $rows]
            );
            Audit::log('site.console', SiteService::siteName($id));
            Response::json(['pending' => $rid], 202);
        }
        $res = Agent::request('POST', "/v1/sites/$id/console", ['actor' => $actor, 'userId' => $uid, 'cols' => $cols, 'rows' => $rows]);
        Audit::log('site.console', SiteService::siteName($id));
        Response::json(['ticket' => (string) ($res['ticket'] ?? ''), 'ttl' => (int) ($res['ttl'] ?? 30)]);
    }

    /** Worker mode: 202 while the worker is still working, then the ticket exactly once (only for the administrator who asked). */
    public static function ticketResult(Request $req, array $p): never
    {
        $rid = (string) ($p['rid'] ?? '');
        $uid = (int) (Auth::user()['id'] ?? 0);
        $row = preg_match('/^[0-9a-f]{32}$/', $rid) === 1 ? Db::one('SELECT ticket, error FROM console_requests WHERE id = ? AND user_id = ?', [$rid, $uid]) : null;
        if ($row === null) {
            throw new HttpException(404, 'The request has expired. Please try again.');
        }
        if ($row['error'] !== null) {
            Db::exec('DELETE FROM console_requests WHERE id = ?', [$rid]);
            throw new HttpException(409, (string) $row['error']);
        }
        if ($row['ticket'] === null) {
            Response::json(['pending' => true], 202);
        }
        Db::exec('DELETE FROM console_requests WHERE id = ?', [$rid]);
        Response::json(['ticket' => (string) $row['ticket'], 'ttl' => 30]);
    }

    /** Ends a running session (administrators). */
    public static function kill(Request $req, array $p): never
    {
        $sid = (string) ($p['sid'] ?? '');
        if (preg_match('/^[0-9a-f]{16}$/', $sid) !== 1) {
            throw new HttpException(404, 'Session not found.');
        }
        $res = Agent::request('POST', "/v1/console/sessions/$sid/kill", ['actor' => (string) (Auth::user()['email'] ?? '')]);
        Audit::log('site.console_kill', $sid);
        Response::json(['ok' => !empty($res['ok'])]);
    }

    /**
     * Called by the reverse proxy (auth_request) before the WebSocket is forwarded to the agent: 204 = the session belongs to a
     * signed-in administrator (checked by the central permission rules) and the request comes from the dashboard's own page.
     */
    public static function auth(Request $req): never
    {
        $origin = $req->header('Origin');
        $oh = $origin === '' ? null : parse_url($origin, PHP_URL_HOST);
        $op = $origin === '' ? null : parse_url($origin, PHP_URL_PORT);
        $originHost = is_string($oh) ? strtolower($oh) . ($op ? ':' . $op : '') : '';
        $seen = self::cleanHost($req->header('X-Original-Host'));
        // a default port is not part of the Origin; compare without it
        $strip = static fn (string $h): string => preg_replace('/:(80|443)$/', '', $h) ?? $h;
        if ($originHost === '' || $seen === '' || $strip($originHost) !== $strip($seen)) {
            Audit::log('security.origin_mismatch', '/__console', ['origin' => mb_substr($origin, 0, 100)]);
            throw new HttpException(403, 'Not allowed');
        }
        http_response_code(204);
        exit;
    }
}
