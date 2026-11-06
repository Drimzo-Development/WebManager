<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\Auth;
use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Support\Audit;
use WebManager\Support\Crypto;
use WebManager\Support\Db;
use WebManager\Support\Totp;
use WebManager\Support\WebAuthn;

/** The signed-in user's own account: profile and two-factor authentication. Available to every role. */
final class AccountApi
{
    /** @return array<string,mixed> */
    private static function row(): array
    {
        $uid = (int) (Auth::user()['id'] ?? 0);
        $r = Db::one('SELECT id, email, name, role, password_hash, totp_secret_enc, totp_enabled FROM users WHERE id = ?', [$uid]);
        if (!$r) {
            throw new HttpException(404, 'User not found');
        }
        return $r;
    }

    /** 2FA changes always require the current password, so a hijacked session alone cannot switch it off. */
    private static function requirePassword(array $user, Request $req): void
    {
        if (!password_verify((string) ($req->json()['password'] ?? ''), (string) $user['password_hash'])) {
            Audit::log('auth.2fa_password_wrong', (string) $user['email']);
            throw new HttpException(403, 'The current password is wrong.');
        }
    }

    public static function show(Request $req): never
    {
        $u = self::row();
        $left = (int) Db::val('SELECT COUNT(*) FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', [(int) $u['id']]);
        $passkeys = array_map(static fn ($r) => ['id' => (int) $r['id'], 'name' => $r['name'], 'created_at' => str_replace(' ', 'T', (string) $r['created_at']) . 'Z', 'last_used_at' => $r['last_used_at'] ? str_replace(' ', 'T', (string) $r['last_used_at']) . 'Z' : null], Db::all('SELECT id, name, created_at, last_used_at FROM user_passkeys WHERE user_id = ? ORDER BY id', [(int) $u['id']]));
        Response::json([
            'email' => $u['email'], 'name' => $u['name'], 'role' => $u['role'],
            'two_factor' => (bool) $u['totp_enabled'] || $passkeys !== [], 'totp' => (bool) $u['totp_enabled'], 'passkeys' => $passkeys, 'passkeys_possible' => self::rp($req) !== null, 'recovery_left' => $left,
            'two_factor_required' => Auth::policyCovers(Auth::twoFactorPolicy(), (string) $u['role']),
        ]);
    }

    /** Step 1: a fresh secret is kept in the session only; nothing changes until a valid code confirms it. */
    public static function setup(Request $req): never
    {
        $u = self::row();
        if ((int) $u['totp_enabled'] === 1) {
            throw new HttpException(409, 'Two-factor authentication is already active.');
        }
        self::requirePassword($u, $req);
        $secret = Totp::generateSecret();
        $_SESSION['totp_setup'] = $secret;
        Response::json(['secret' => $secret, 'uri' => Totp::uri($secret, (string) $u['email'], \WebManager\Support\Brand::name())]);
    }

    /** Step 2: the user proves the authenticator app works by entering a current code. */
    public static function enable(Request $req): never
    {
        $u = self::row();
        $secret = (string) ($_SESSION['totp_setup'] ?? '');
        if ($secret === '') {
            throw new HttpException(409, 'Please restart the setup.');
        }
        $step = Totp::verify($secret, (string) ($req->json()['code'] ?? ''));
        if ($step === null) {
            throw new HttpException(422, 'The code is wrong. Check your device’s clock and try again.');
        }
        Db::exec('UPDATE users SET totp_secret_enc = ?, totp_enabled = 1, totp_last_step = ? WHERE id = ?', [Crypto::encrypt($secret), $step, (int) $u['id']]);
        unset($_SESSION['totp_setup']);
        $codes = Auth::newRecoveryCodes((int) $u['id']);
        Audit::log('auth.2fa_enabled', (string) $u['email']);
        Response::json(['recovery_codes' => $codes]);
    }

    public static function disable(Request $req): never
    {
        $u = self::row();
        if (Auth::policyCovers(Auth::twoFactorPolicy(), (string) $u['role']) && Auth::passkeyCount((int) $u['id']) === 0) {
            throw new HttpException(403, 'Two-factor authentication is mandatory for your role. Set up a passkey first if you want to remove the authenticator app.');
        }
        self::requirePassword($u, $req);
        Db::exec('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = 0 WHERE id = ?', [(int) $u['id']]);
        Db::exec('DELETE FROM user_recovery_codes WHERE user_id = ?', [(int) $u['id']]);
        Audit::log('auth.2fa_disabled', (string) $u['email']);
        Response::json(['ok' => true]);
    }

    /** Relying party of this dashboard: domain name and origin. Passkeys need a domain name and HTTPS (localhost is allowed for tests). @return array{id:string,origin:string}|null */
    public static function rp(Request $req): ?array
    {
        return self::rpFrom($req, trim((string) Db::val("SELECT v FROM settings WHERE k = 'public_url'")));
    }

    /**
     * With a configured public address (System & settings → Sign-in) domain and origin come from it and NOT from the request:
     * a phishing proxy that forwards a visitor cannot change them (the authenticator signs the origin of the page the visitor sees).
     * Without it they are derived from the forwarded host and scheme.
     * @return array{id:string,origin:string}|null
     */
    public static function rpFrom(Request $req, string $configured): ?array
    {
        if ($configured !== '') {
            $host = strtolower((string) parse_url($configured, PHP_URL_HOST));
            return $host === '' ? null : ['id' => $host, 'origin' => $configured];
        }
        $hostHeader = $req->header('X-Forwarded-Host') ?: $req->header('Host');
        $host = strtolower((string) parse_url('http://' . $hostHeader, PHP_URL_HOST));
        $port = parse_url('http://' . $hostHeader, PHP_URL_PORT);
        if ($host === '' || filter_var(trim($host, '[]'), FILTER_VALIDATE_IP) || !preg_match('/^[a-z0-9.-]+$/', $host)) {
            return null;
        }
        $local = $host === 'localhost' || str_ends_with($host, '.localhost');
        if (!$req->isHttps() && !$local) {
            return null;
        }
        return ['id' => $host, 'origin' => ($req->isHttps() ? 'https' : 'http') . '://' . $host . ($port ? ':' . $port : '')];
    }

    /** Step 1 of adding a passkey: options for navigator.credentials.create (needs the password like every second-factor change). */
    public static function passkeyOptions(Request $req): never
    {
        $u = self::row();
        self::requirePassword($u, $req);
        $rp = self::rp($req);
        if ($rp === null) {
            throw new HttpException(422, 'Passkeys only work through the dashboard domain with HTTPS (not through the IP address).');
        }
        if ((int) Db::val('SELECT COUNT(*) FROM user_passkeys WHERE user_id = ?', [(int) $u['id']]) >= 10) {
            throw new HttpException(422, 'At most 10 passkeys per account are possible.');
        }
        $challenge = random_bytes(32);
        $_SESSION['pk_reg'] = ['c' => WebAuthn::b64uEncode($challenge), 't' => time()];
        $exclude = array_map(static fn ($r) => ['type' => 'public-key', 'id' => WebAuthn::b64uEncode((string) $r['credential_id'])], Db::all('SELECT credential_id FROM user_passkeys WHERE user_id = ?', [(int) $u['id']]));
        Response::json([
            'challenge' => WebAuthn::b64uEncode($challenge),
            'rp' => ['name' => \WebManager\Support\Brand::name(), 'id' => $rp['id']],
            'user' => ['id' => WebAuthn::b64uEncode(hash_hmac('sha256', 'user:' . $u['id'], \WebManager\Support\Env::require('APP_KEY'), true)), 'name' => (string) $u['email'], 'displayName' => (string) ($u['name'] !== '' ? $u['name'] : $u['email'])],
            'pubKeyCredParams' => [['type' => 'public-key', 'alg' => WebAuthn::ALG_ES256], ['type' => 'public-key', 'alg' => WebAuthn::ALG_RS256]],
            'timeout' => 120000,
            'attestation' => 'none',
            'authenticatorSelection' => ['residentKey' => 'preferred', 'userVerification' => 'preferred'],
            'excludeCredentials' => $exclude,
        ]);
    }

    /** Step 2: verifies the authenticator's answer and stores the passkey. The first passkey of an account without recovery codes also creates them. */
    public static function passkeyRegister(Request $req): never
    {
        $u = self::row();
        $in = $req->json();
        $pending = $_SESSION['pk_reg'] ?? null;
        unset($_SESSION['pk_reg']);
        $rp = self::rp($req);
        if (!is_array($pending) || time() - (int) $pending['t'] > 300 || $rp === null) {
            throw new HttpException(409, 'The registration has expired. Please start again.');
        }
        $name = trim((string) ($in['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > 100) {
            throw new HttpException(422, 'Please enter a name for the passkey (max. 100 characters).');
        }
        $resp = $in['response'] ?? null;
        try {
            if (!is_array($resp)) {
                throw new \RuntimeException('Invalid answer.');
            }
            $v = WebAuthn::verifyRegistration(
                WebAuthn::b64uDecode((string) ($resp['clientDataJSON'] ?? '')),
                WebAuthn::b64uDecode((string) ($resp['attestationObject'] ?? '')),
                WebAuthn::b64uDecode((string) $pending['c']),
                $rp['id'],
                [$rp['origin']]
            );
        } catch (\RuntimeException $e) {
            throw new HttpException(422, 'The passkey was not accepted: ' . $e->getMessage());
        }
        if (Db::val('SELECT id FROM user_passkeys WHERE credential_id = ?', [$v['id']])) {
            throw new HttpException(409, 'This passkey is already registered.');
        }
        $id = Db::insert('INSERT INTO user_passkeys (user_id, credential_id, public_key, alg, sign_count, name) VALUES (?, ?, ?, ?, ?, ?)', [(int) $u['id'], $v['id'], $v['cose'], $v['alg'], $v['signCount'], $name]);
        Audit::log('auth.passkey_added', (string) $u['email'], ['name' => $name]);
        $codes = null;
        if ((int) Db::val('SELECT COUNT(*) FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', [(int) $u['id']]) === 0) {
            $codes = Auth::newRecoveryCodes((int) $u['id']);
        }
        Response::json(['id' => $id, 'recovery_codes' => $codes], 201);
    }

    public static function passkeyRemove(Request $req, array $p): never
    {
        $u = self::row();
        self::requirePassword($u, $req);
        $pid = filter_var($p['pid'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $row = $pid === false ? null : Db::one('SELECT id, name FROM user_passkeys WHERE id = ? AND user_id = ?', [$pid, (int) $u['id']]);
        if (!$row) {
            throw new HttpException(404, 'Passkey not found');
        }
        $left = Auth::passkeyCount((int) $u['id']) - 1;
        if ($left === 0 && (int) $u['totp_enabled'] !== 1 && Auth::policyCovers(Auth::twoFactorPolicy(), (string) $u['role'])) {
            throw new HttpException(403, 'This is your last second factor, and two-factor authentication is mandatory for your role.');
        }
        Db::exec('DELETE FROM user_passkeys WHERE id = ?', [(int) $row['id']]);
        Audit::log('auth.passkey_removed', (string) $u['email'], ['name' => (string) $row['name']]);
        Response::json(['ok' => true]);
    }

    public static function recovery(Request $req): never
    {
        $u = self::row();
        if ((int) $u['totp_enabled'] !== 1 && Auth::passkeyCount((int) $u['id']) === 0) {
            throw new HttpException(409, 'Two-factor authentication is not active.');
        }
        self::requirePassword($u, $req);
        $codes = Auth::newRecoveryCodes((int) $u['id']);
        Audit::log('auth.2fa_recovery_renewed', (string) $u['email']);
        Response::json(['recovery_codes' => $codes]);
    }
}
