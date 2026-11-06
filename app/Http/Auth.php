<?php
declare(strict_types=1);

namespace WebManager\Http;

use WebManager\Support\Audit;
use WebManager\Support\Crypto;
use WebManager\Support\Db;
use WebManager\Support\Env;
use WebManager\Support\Totp;

final class Auth
{
    private const IDLE_SECONDS = 7200;
    private const ABSOLUTE_SECONDS = 43200;

    public static function start(Request $req): void
    {
        $path = Env::get('SESSION_PATH', '/tmp/sessions');
        if (!is_dir($path)) {
            @mkdir($path, 0700, true);
        }
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.gc_maxlifetime', (string) self::ABSOLUTE_SECONDS);
        session_save_path($path);
        session_name('wm_sid');
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => '/',
            'secure' => $req->isHttps(),
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
        session_start();

        if (isset($_SESSION['uid'])) {
            // role, deactivation and password changes take effect on the very next request
            $row = Db::one('SELECT email, name, role, active, password_hash FROM users WHERE id = ?', [(int) $_SESSION['uid']]);
            $gone = $row === null || !(int) $row['active'] || !isset(self::ROLES[(string) $row['role']])
                || !hash_equals((string) ($_SESSION['pwf'] ?? ''), self::pwFingerprint((string) $row['password_hash']));
            if ($gone) {
                self::destroy();
                session_start();
            } else {
                $_SESSION['email'] = (string) $row['email'];
                $_SESSION['name'] = (string) $row['name'];
                $_SESSION['role'] = (string) $row['role'];
            }
        }
        if (isset($_SESSION['uid'])) {
            $now = time();
            $expired = ($now - ($_SESSION['last'] ?? 0)) > self::IDLE_SECONDS
                || ($now - ($_SESSION['born'] ?? 0)) > self::ABSOLUTE_SECONDS
                || !hash_equals((string) ($_SESSION['ua'] ?? ''), hash('sha256', $req->userAgent()));
            if ($expired) {
                self::destroy();
                session_start();
            } else {
                $_SESSION['last'] = $now;
            }
        }
        if (empty($_SESSION['csrf'])) {
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
        }
    }

    /** Accounts of a role that is not listed here (the former "customer" role) cannot sign in and have no rights at all. */
    public const ROLES = ['viewer' => 1, 'operator' => 2, 'admin' => 3];
    /** Returned by attempt() when the password was right but a second factor is required. */
    public const NEEDS_2FA = '__2fa__';

    public static function pwFingerprint(string $hash): string
    {
        return substr(hash('sha256', $hash), 0, 16);
    }

    /**
     * Acts as the owner of an API token for this one request: no session, no cookie, no CSRF (the token is not sent
     * automatically by browsers). The role is already capped by the token.
     * @param array{id:int,email:string,name:string,role:string,token_id:int} $user
     */
    public static function actAsToken(array $user): void
    {
        $_SESSION = ['uid' => $user['id'], 'email' => $user['email'], 'name' => $user['name'], 'role' => $user['role'], 'token_id' => $user['token_id']];
    }

    public static function viaToken(): bool
    {
        return isset($_SESSION['token_id']);
    }

    public static function tokenId(): ?int
    {
        return isset($_SESSION['token_id']) ? (int) $_SESSION['token_id'] : null;
    }

    /** @return array{id:int,email:string,name:string,role:string}|null */
    public static function user(): ?array
    {
        if (!isset($_SESSION['uid'])) {
            return null;
        }
        return [
            'id' => (int) $_SESSION['uid'],
            'email' => (string) $_SESSION['email'],
            'name' => (string) ($_SESSION['name'] ?? ''),
            'role' => (string) ($_SESSION['role'] ?? 'viewer'),
        ];
    }

    /** Policy for the second factor: 'off' (voluntary), 'admins' or 'all' (mandatory). */
    public static function twoFactorPolicy(): string
    {
        $p = (string) (Db::val("SELECT v FROM settings WHERE k = 'require_2fa'") ?: 'off');
        return in_array($p, ['off', 'admins', 'all'], true) ? $p : 'off';
    }

    public static function policyCovers(string $policy, string $role): bool
    {
        return $policy === 'all' || ($policy === 'admins' && $role === 'admin');
    }

    /** True when the signed-in user has to set up 2FA first (mandatory for their role, but not active yet). */
    public static function twoFactorMissing(): bool
    {
        $u = self::user();
        if ($u === null || !self::policyCovers(self::twoFactorPolicy(), $u['role'])) {
            return false;
        }
        return !self::hasSecondFactor((int) $u['id']);
    }

    public static function can(string $minRole): bool
    {
        $u = self::user();
        return $u !== null && (self::ROLES[$u['role']] ?? 0) >= (self::ROLES[$minRole] ?? 99);
    }

    public static function csrf(): string
    {
        return (string) ($_SESSION['csrf'] ?? '');
    }

    public static function checkCsrf(Request $req): void
    {
        $sent = $req->header('X-CSRF-Token') ?: $req->post('_csrf');
        if ($sent === '' || !hash_equals(self::csrf(), $sent)) {
            throw new HttpException(403, 'Invalid or missing CSRF token. Please reload the page.');
        }
    }

    /** Failed attempts in the last 15 minutes: 10 per address, 5 per account (the account limit does not apply to an address that signed in before). */
    public static function lockedOut(int $failsByIp, int $failsByMail, bool $knownIp): bool
    {
        return $failsByIp >= 10 || ($failsByMail >= 5 && !$knownIp);
    }

    /** Returns null on success, NEEDS_2FA when a second factor is required, otherwise an error message. */
    public static function attempt(Request $req, string $email, string $password): ?string
    {
        $email = mb_strtolower(trim($email));
        $ip = $req->ip();
        // invalid API tokens ('api-token') have their own limit (ApiToken::authenticate) and must not lock the password login
        $byIp = (int) Db::val("SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND email <> 'api-token' AND success = 0 AND created_at > NOW() - INTERVAL 15 MINUTE", [$ip]);
        $byMail = (int) Db::val('SELECT COUNT(*) FROM login_attempts WHERE email = ? AND success = 0 AND created_at > NOW() - INTERVAL 15 MINUTE', [$email]);
        // the per-account limit stops guessing from many addresses; an address that has signed in to this account before is not
        // locked out by it, so strangers cannot lock the owner out (the limit per address still applies)
        $knownIp = $byMail >= 5 && (int) Db::val('SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND email = ? AND success = 1 AND created_at > NOW() - INTERVAL 7 DAY', [$ip, mb_substr($email, 0, 190)]) > 0;
        if (self::lockedOut($byIp, $byMail, $knownIp)) {
            Audit::log('auth.locked', $email, ['ip' => $ip], null);
            return 'Too many failed attempts. Please try again in 15 minutes.';
        }
        $user = Db::one('SELECT id, email, name, role, active, password_hash, totp_enabled FROM users WHERE email = ?', [$email]);
        // constant-ish time: always run a hash verification
        $hash = $user['password_hash'] ?? password_hash(bin2hex(random_bytes(8)), PASSWORD_ARGON2ID);
        $ok = password_verify($password, $hash) && $user !== null && (int) $user['active'] === 1 && isset(self::ROLES[(string) $user['role']]);
        Db::exec('INSERT INTO login_attempts (ip, email, success) VALUES (?, ?, ?)', [$ip, mb_substr($email, 0, 190), $ok ? 1 : 0]);
        if (!$ok) {
            Audit::log('auth.failed', $email, ['ip' => $ip], null);
            return 'Email or password is wrong.';
        }
        $storedHash = (string) $user['password_hash'];
        if (password_needs_rehash($storedHash, PASSWORD_ARGON2ID)) {
            $storedHash = password_hash($password, PASSWORD_ARGON2ID);
            Db::exec('UPDATE users SET password_hash = ? WHERE id = ?', [$storedHash, $user['id']]);
        }
        $user['password_hash'] = $storedHash;
        if ((int) $user['totp_enabled'] === 1 || self::passkeyCount((int) $user['id']) > 0) {
            // password is right, the second factor is still missing: nothing is logged in yet
            session_regenerate_id(true);
            $_SESSION['pending_2fa'] = ['uid' => (int) $user['id'], 'at' => time()];
            return self::NEEDS_2FA;
        }
        self::establish($req, $user);
        return null;
    }

    public static function passkeyCount(int $uid): int
    {
        return (int) Db::val('SELECT COUNT(*) FROM user_passkeys WHERE user_id = ?', [$uid]);
    }

    /** Authenticator app or at least one passkey. */
    public static function hasSecondFactor(int $uid): bool
    {
        return (int) Db::val('SELECT totp_enabled FROM users WHERE id = ?', [$uid]) === 1 || self::passkeyCount($uid) > 0;
    }

    /** @return array{totp:bool,passkey:bool}|null methods of the user who entered the password and waits for the second factor */
    public static function pendingMethods(): ?array
    {
        if (!self::hasPendingTwoFactor()) {
            return null;
        }
        $uid = (int) $_SESSION['pending_2fa']['uid'];
        return ['totp' => (int) Db::val('SELECT totp_enabled FROM users WHERE id = ?', [$uid]) === 1, 'passkey' => self::passkeyCount($uid) > 0];
    }

    /** Finishes the login after a successful passkey assertion (the caller verified it). */
    public static function completePasskey(Request $req, int $uid): void
    {
        $user = Db::one('SELECT id, email, name, role, active, password_hash FROM users WHERE id = ?', [$uid]);
        if (!$user || (int) $user['active'] !== 1) {
            throw new HttpException(403, 'The account is deactivated.');
        }
        Db::exec('INSERT INTO login_attempts (ip, email, success) VALUES (?, ?, 1)', [$req->ip(), '2fa:' . $uid]);
        Audit::log('auth.passkey_login', (string) $user['email'], ['ip' => $req->ip()], $uid);
        unset($_SESSION['pending_2fa']);
        session_regenerate_id(true);
        self::establish($req, $user);
    }

    /** True while a user has entered the right password but not yet the second factor (valid for 5 minutes). */
    public static function hasPendingTwoFactor(): bool
    {
        $p = $_SESSION['pending_2fa'] ?? null;
        return is_array($p) && time() - (int) ($p['at'] ?? 0) <= 300;
    }

    /** Finishes a login with a TOTP code or a recovery code. Returns null on success, otherwise an error message. */
    public static function completeTwoFactor(Request $req, string $code): ?string
    {
        if (!self::hasPendingTwoFactor()) {
            unset($_SESSION['pending_2fa']);
            return 'The sign-in has expired. Please sign in again.';
        }
        $uid = (int) $_SESSION['pending_2fa']['uid'];
        $tag = '2fa:' . $uid;
        $ip = $req->ip();
        $fails = (int) Db::val('SELECT COUNT(*) FROM login_attempts WHERE email = ? AND success = 0 AND created_at > NOW() - INTERVAL 15 MINUTE', [$tag]);
        if ($fails >= 5) {
            Audit::log('auth.locked_2fa', $tag, ['ip' => $ip], null);
            return 'Too many failed attempts. Please try again in 15 minutes.';
        }
        $user = Db::one('SELECT id, email, name, role, active, password_hash, totp_secret_enc, totp_enabled, totp_last_step FROM users WHERE id = ?', [$uid]);
        $ok = false;
        if ($user && (int) $user['active'] === 1 && (int) $user['totp_enabled'] !== 1) {
            // passkey-only account: a recovery code is the way in without the passkey
            if (self::useRecoveryCode($uid, $code)) {
                $ok = true;
                Audit::log('auth.recovery_code_used', (string) $user['email'], ['ip' => $ip], $uid);
            }
        } elseif ($user && (int) $user['active'] === 1) {
            $step = Totp::verify(Crypto::decrypt((string) $user['totp_secret_enc']), $code, (int) $user['totp_last_step']);
            if ($step !== null) {
                // the update only succeeds once per step, so the same code can never be used twice
                $ok = Db::exec('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?', [$step, $uid, $step]) === 1;
            } elseif (self::useRecoveryCode($uid, $code)) {
                $ok = true;
                Audit::log('auth.recovery_code_used', (string) $user['email'], ['ip' => $ip], $uid);
            }
        }
        Db::exec('INSERT INTO login_attempts (ip, email, success) VALUES (?, ?, ?)', [$ip, $tag, $ok ? 1 : 0]);
        if (!$ok) {
            Audit::log('auth.failed_2fa', $user['email'] ?? $tag, ['ip' => $ip], null);
            return 'The code is invalid or has already been used.';
        }
        unset($_SESSION['pending_2fa']);
        session_regenerate_id(true);
        self::establish($req, $user);
        return null;
    }

    private static function useRecoveryCode(int $uid, string $code): bool
    {
        $norm = strtolower(preg_replace('/[^A-Za-z0-9]/', '', $code) ?? '');
        if (strlen($norm) !== 16) {
            return false;
        }
        $hash = hash('sha256', $norm);
        return Db::exec('UPDATE user_recovery_codes SET used_at = NOW() WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', [$uid, $hash]) === 1;
    }

    /** Creates 10 new recovery codes (replacing all old ones) and returns them in readable form. They are shown exactly once. @return list<string> */
    public static function newRecoveryCodes(int $uid): array
    {
        Db::exec('DELETE FROM user_recovery_codes WHERE user_id = ?', [$uid]);
        $codes = [];
        for ($i = 0; $i < 10; $i++) {
            $raw = strtolower(Totp::base32Encode(random_bytes(10))); // 16 characters = 80 bits
            Db::exec('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)', [$uid, hash('sha256', $raw)]);
            $codes[] = implode('-', str_split($raw, 4));
        }
        return $codes;
    }

    /** @param array<string,mixed> $user needs id, email, name, role, password_hash */
    private static function establish(Request $req, array $user): void
    {
        session_regenerate_id(true);
        $_SESSION['uid'] = (int) $user['id'];
        $_SESSION['email'] = (string) $user['email'];
        $_SESSION['name'] = (string) $user['name'];
        $_SESSION['role'] = (string) $user['role'];
        $_SESSION['pwf'] = self::pwFingerprint((string) $user['password_hash']);
        $_SESSION['born'] = $_SESSION['last'] = time();
        $_SESSION['ua'] = hash('sha256', $req->userAgent());
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        Db::exec('UPDATE users SET last_login_at = NOW() WHERE id = ?', [$user['id']]);
        Audit::log('auth.login', (string) $user['email'], ['ip' => $req->ip()], (int) $user['id']);
        \WebManager\Services\LoginAlert::queue($req, $user);
    }

    public static function destroy(): void
    {
        // open web consoles of this account end with the session
        \WebManager\Services\ConsoleGuard::endUser((int) ($_SESSION['uid'] ?? 0), 'signed out');
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', ['expires' => time() - 3600, 'path' => $p['path'], 'secure' => $p['secure'], 'httponly' => true, 'samesite' => 'Strict']);
        }
        session_destroy();
    }

    public static function passwordPolicyError(string $pw): ?string
    {
        if (mb_strlen($pw) < 12) {
            return 'The password must be at least 12 characters long.';
        }
        if (mb_strlen($pw) > 200) {
            return 'The password is too long.';
        }
        $classes = (preg_match('/[a-z]/', $pw) ? 1 : 0) + (preg_match('/[A-Z]/', $pw) ? 1 : 0) + (preg_match('/\d/', $pw) ? 1 : 0) + (preg_match('/[^a-zA-Z0-9]/', $pw) ? 1 : 0);
        if ($classes < 3) {
            return 'The password must contain at least three of the character classes lowercase, uppercase, digits and special characters.';
        }
        return null;
    }
}
