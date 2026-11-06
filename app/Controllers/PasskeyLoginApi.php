<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\Auth;
use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Support\Audit;
use WebManager\Support\Db;
use WebManager\Support\WebAuthn;

/** Second step of the login with a passkey. Public routes: they only work for a session that has just passed the password check. */
final class PasskeyLoginApi
{
    private static function pendingUid(Request $req): int
    {
        Auth::checkCsrf($req);
        if (!Auth::hasPendingTwoFactor()) {
            throw new HttpException(409, 'The sign-in has expired. Please sign in again.');
        }
        $uid = (int) $_SESSION['pending_2fa']['uid'];
        $fails = (int) Db::val('SELECT COUNT(*) FROM login_attempts WHERE email = ? AND success = 0 AND created_at > NOW() - INTERVAL 15 MINUTE', ['2fa:' . $uid]);
        if ($fails >= 5) {
            Audit::log('auth.locked_2fa', '2fa:' . $uid, ['ip' => $req->ip()], null);
            throw new HttpException(429, 'Too many failed attempts. Please try again in 15 minutes.');
        }
        return $uid;
    }

    /** Without a password: the browser offers the passkeys stored on the device (no username needed). */
    public static function signinOptions(Request $req): never
    {
        Auth::checkCsrf($req);
        self::tooManyFailures($req);
        $rp = AccountApi::rp($req);
        if ($rp === null) {
            throw new HttpException(422, 'Passkeys only work through the dashboard domain with HTTPS (not through the IP address).');
        }
        $challenge = random_bytes(32);
        $_SESSION['pk_login'] = ['c' => WebAuthn::b64uEncode($challenge), 't' => time()];
        Response::json(['challenge' => WebAuthn::b64uEncode($challenge), 'rpId' => $rp['id'], 'timeout' => 120000, 'userVerification' => 'required', 'allowCredentials' => []]);
    }

    /** Completes the sign-in: passkey + the device's own user verification are two factors, so no password and no code are asked. */
    public static function signinVerify(Request $req): never
    {
        Auth::checkCsrf($req);
        self::tooManyFailures($req);
        $pending = $_SESSION['pk_login'] ?? null;
        unset($_SESSION['pk_login']);
        $rp = AccountApi::rp($req);
        $fail = static function (string $msg) use ($req): never {
            Db::exec('INSERT INTO login_attempts (ip, email, success) VALUES (?, ?, 0)', [$req->ip(), 'passkey']);
            Audit::log('auth.failed', 'passkey', ['ip' => $req->ip(), 'method' => 'passkey'], null);
            throw new HttpException(403, $msg);
        };
        if (!is_array($pending) || time() - (int) $pending['t'] > 300 || $rp === null) {
            throw new HttpException(409, 'The sign-in has expired. Please start again.');
        }
        $in = $req->json();
        $resp = $in['response'] ?? null;
        try {
            if (!is_array($resp)) {
                throw new \RuntimeException('Invalid answer.');
            }
            $credId = WebAuthn::b64uDecode((string) ($in['id'] ?? ''));
            $row = Db::one('SELECT p.id, p.user_id, p.public_key, p.sign_count, u.active FROM user_passkeys p JOIN users u ON u.id = p.user_id WHERE p.credential_id = ?', [$credId]);
            if (!$row || !(int) $row['active']) {
                throw new \RuntimeException('This passkey is not known or the account is deactivated.');
            }
            // the user handle stored by the authenticator must be the one this server derived for that account
            $handle = (string) ($resp['userHandle'] ?? '');
            if ($handle !== '' && !hash_equals(WebAuthn::b64uEncode(hash_hmac('sha256', 'user:' . $row['user_id'], \WebManager\Support\Env::require('APP_KEY'), true)), $handle)) {
                throw new \RuntimeException('The passkey belongs to a different account.');
            }
            $res = WebAuthn::verifyAssertion(
                WebAuthn::b64uDecode((string) ($resp['clientDataJSON'] ?? '')),
                WebAuthn::b64uDecode((string) ($resp['authenticatorData'] ?? '')),
                WebAuthn::b64uDecode((string) ($resp['signature'] ?? '')),
                WebAuthn::b64uDecode((string) $pending['c']),
                $rp['id'],
                [$rp['origin']],
                (string) $row['public_key'],
                (int) $row['sign_count'],
                true
            );
        } catch (\RuntimeException $e) {
            $fail('The passkey was not accepted: ' . $e->getMessage());
        }
        Db::exec('UPDATE user_passkeys SET sign_count = ?, last_used_at = NOW() WHERE id = ?', [$res['signCount'], (int) $row['id']]);
        Auth::completePasskey($req, (int) $row['user_id']);
        Response::json(['redirect' => '/']);
    }

    private static function tooManyFailures(Request $req): void
    {
        $fails = (int) Db::val("SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND success = 0 AND created_at > NOW() - INTERVAL 15 MINUTE", [$req->ip()]);
        if ($fails >= 10) {
            Audit::log('auth.locked', 'passkey', ['ip' => $req->ip()], null);
            throw new HttpException(429, 'Too many failed attempts. Please try again in 15 minutes.');
        }
    }

    public static function options(Request $req): never
    {
        $uid = self::pendingUid($req);
        $rp = AccountApi::rp($req);
        $creds = Db::all('SELECT credential_id FROM user_passkeys WHERE user_id = ?', [$uid]);
        if ($rp === null || !$creds) {
            throw new HttpException(422, 'No passkeys are available for this account here. Use the code from the authenticator app or a recovery code.');
        }
        $challenge = random_bytes(32);
        $_SESSION['pk_auth'] = ['c' => WebAuthn::b64uEncode($challenge), 't' => time(), 'u' => $uid];
        Response::json([
            'challenge' => WebAuthn::b64uEncode($challenge),
            'rpId' => $rp['id'],
            'timeout' => 120000,
            'userVerification' => 'preferred',
            'allowCredentials' => array_map(static fn ($c) => ['type' => 'public-key', 'id' => WebAuthn::b64uEncode((string) $c['credential_id'])], $creds),
        ]);
    }

    public static function verify(Request $req): never
    {
        $uid = self::pendingUid($req);
        $pending = $_SESSION['pk_auth'] ?? null;
        unset($_SESSION['pk_auth']);
        $rp = AccountApi::rp($req);
        $fail = static function (string $msg) use ($req, $uid): never {
            Db::exec('INSERT INTO login_attempts (ip, email, success) VALUES (?, ?, 0)', [$req->ip(), '2fa:' . $uid]);
            Audit::log('auth.failed_2fa', '2fa:' . $uid, ['ip' => $req->ip(), 'method' => 'passkey'], null);
            throw new HttpException(403, $msg); // not 401: the client would treat that as "logged out" and leave the page
        };
        if (!is_array($pending) || (int) $pending['u'] !== $uid || time() - (int) $pending['t'] > 300 || $rp === null) {
            throw new HttpException(409, 'The sign-in has expired. Please start again.');
        }
        $in = $req->json();
        $resp = $in['response'] ?? null;
        try {
            if (!is_array($resp)) {
                throw new \RuntimeException('Invalid answer.');
            }
            $credId = WebAuthn::b64uDecode((string) ($in['id'] ?? ''));
            $row = Db::one('SELECT id, public_key, sign_count FROM user_passkeys WHERE credential_id = ? AND user_id = ?', [$credId, $uid]);
            if (!$row) {
                throw new \RuntimeException('This passkey does not belong to this account.');
            }
            $res = WebAuthn::verifyAssertion(
                WebAuthn::b64uDecode((string) ($resp['clientDataJSON'] ?? '')),
                WebAuthn::b64uDecode((string) ($resp['authenticatorData'] ?? '')),
                WebAuthn::b64uDecode((string) ($resp['signature'] ?? '')),
                WebAuthn::b64uDecode((string) $pending['c']),
                $rp['id'],
                [$rp['origin']],
                (string) $row['public_key'],
                (int) $row['sign_count']
            );
        } catch (\RuntimeException $e) {
            $fail('The passkey was not accepted: ' . $e->getMessage());
        }
        Db::exec('UPDATE user_passkeys SET sign_count = ?, last_used_at = NOW() WHERE id = ?', [$res['signCount'], (int) $row['id']]);
        Auth::completePasskey($req, $uid);
        Response::json(['redirect' => '/']);
    }
}
