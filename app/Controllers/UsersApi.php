<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\Auth;
use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\ConsoleGuard;
use WebManager\Support\ApiToken;
use WebManager\Support\Audit;
use WebManager\Support\Db;

final class UsersApi
{
    private static function id(array $p): int
    {
        $id = filter_var($p['id'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($id === false) {
            throw new HttpException(404, 'User not found');
        }
        return (int) $id;
    }

    /** @return array<string,mixed> */
    private static function row(int $id): array
    {
        $r = Db::one('SELECT id, email, name, role, active, totp_enabled, created_at, last_login_at FROM users WHERE id = ?', [$id]);
        if (!$r) {
            throw new HttpException(404, 'User not found');
        }
        return $r;
    }

    /** @param array<string,mixed> $r @return array<string,mixed> */
    private static function present(array $r): array
    {
        return [
            'id' => (int) $r['id'], 'email' => $r['email'], 'name' => $r['name'], 'role' => $r['role'], 'active' => (bool) $r['active'], 'two_factor' => (bool) $r['totp_enabled'] || \WebManager\Http\Auth::passkeyCount((int) $r['id']) > 0,
            'created_at' => str_replace(' ', 'T', (string) $r['created_at']) . 'Z',
            'last_login_at' => $r['last_login_at'] ? str_replace(' ', 'T', (string) $r['last_login_at']) . 'Z' : null,
            'self' => (int) $r['id'] === (Auth::user()['id'] ?? 0),
        ];
    }

    private static function role(mixed $v): string
    {
        if (!is_string($v) || !isset(Auth::ROLES[$v])) {
            throw new HttpException(422, 'Unknown role.');
        }
        return $v;
    }

    private static function name(mixed $v): string
    {
        $n = trim((string) $v);
        if (mb_strlen($n) > 100) {
            throw new HttpException(422, 'Name: at most 100 characters.');
        }
        return $n;
    }

    /** Refuses changes that would leave the system without an active administrator. */
    private static function keepAnAdmin(int $exceptId): void
    {
        $others = (int) Db::val("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", [$exceptId]);
        if ($others < 1) {
            throw new HttpException(409, 'At least one active administrator must remain.');
        }
    }

    public static function list(Request $req): never
    {
        $rows = Db::all('SELECT id, email, name, role, active, totp_enabled, created_at, last_login_at FROM users ORDER BY email');
        Response::json(['users' => array_map([self::class, 'present'], $rows)]);
    }

    public static function create(Request $req): never
    {
        $in = $req->json();
        $email = mb_strtolower(trim((string) ($in['email'] ?? '')));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 190) {
            throw new HttpException(422, 'Please enter a valid email address.');
        }
        if (Db::val('SELECT id FROM users WHERE email = ?', [$email])) {
            throw new HttpException(422, 'This email address is already taken.');
        }
        $password = (string) ($in['password'] ?? '');
        if ($err = Auth::passwordPolicyError($password)) {
            throw new HttpException(422, $err);
        }
        $role = self::role($in['role'] ?? 'viewer');
        $id = Db::insert(
            'INSERT INTO users (email, name, password_hash, role, active) VALUES (?, ?, ?, ?, 1)',
            [$email, self::name($in['name'] ?? ''), password_hash($password, PASSWORD_ARGON2ID), $role]
        );
        Audit::log('user.create', $email, ['role' => $role]);
        Response::json(['user' => self::present(self::row($id))], 201);
    }

    public static function update(Request $req, array $p): never
    {
        $id = self::id($p);
        $cur = self::row($id);
        $in = $req->json();
        $role = array_key_exists('role', $in) ? self::role($in['role']) : (string) $cur['role'];
        $active = array_key_exists('active', $in) ? !empty($in['active']) : (bool) $cur['active'];
        $name = array_key_exists('name', $in) ? self::name($in['name']) : (string) $cur['name'];
        if ($id === (Auth::user()['id'] ?? 0) && !$active) {
            throw new HttpException(409, 'You cannot deactivate your own account.');
        }
        if ($cur['role'] === 'admin' && (int) $cur['active'] === 1 && ($role !== 'admin' || !$active)) {
            self::keepAnAdmin($id);
        }
        Db::exec('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?', [$name, $role, $active ? 1 : 0, $id]);
        Audit::log('user.update', (string) $cur['email'], ['role' => $role, 'active' => $active]);
        if ($role !== 'admin' || !$active) {
            ConsoleGuard::endUser($id, 'role changed or deactivated');
        }
        Response::json(['user' => self::present(self::row($id))]);
    }

    public static function setPassword(Request $req, array $p): never
    {
        $id = self::id($p);
        $cur = self::row($id);
        $password = (string) ($req->json()['password'] ?? '');
        if ($err = Auth::passwordPolicyError($password)) {
            throw new HttpException(422, $err);
        }
        $hash = password_hash($password, PASSWORD_ARGON2ID);
        Db::exec('UPDATE users SET password_hash = ? WHERE id = ?', [$hash, $id]);
        if ($id === (Auth::user()['id'] ?? 0)) {
            $_SESSION['pwf'] = Auth::pwFingerprint($hash);
        }
        $revoked = ApiToken::revokeAll($id);
        Audit::log('user.password_reset', (string) $cur['email'], ['tokens_revoked' => $revoked]);
        ConsoleGuard::endUser($id, 'password reset');
        Response::json(['ok' => true]);
    }

    /** For users who lost their device and recovery codes: they can log in with the password alone and set up 2FA again. */
    public static function resetTwoFactor(Request $req, array $p): never
    {
        $id = self::id($p);
        $cur = self::row($id);
        Db::exec('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = 0 WHERE id = ?', [$id]);
        Db::exec('DELETE FROM user_recovery_codes WHERE user_id = ?', [$id]);
        Db::exec('DELETE FROM user_passkeys WHERE user_id = ?', [$id]);
        Audit::log('user.2fa_reset', (string) $cur['email']);
        ConsoleGuard::endUser($id, 'two-factor authentication reset');
        Response::json(['ok' => true]);
    }

    public static function delete(Request $req, array $p): never
    {
        $id = self::id($p);
        $cur = self::row($id);
        if ($id === (Auth::user()['id'] ?? 0)) {
            throw new HttpException(409, 'You cannot delete your own account.');
        }
        if ($cur['role'] === 'admin' && (int) $cur['active'] === 1) {
            self::keepAnAdmin($id);
        }
        Db::exec('DELETE FROM users WHERE id = ?', [$id]);
        Audit::log('user.delete', (string) $cur['email']);
        ConsoleGuard::endUser($id, 'account deleted');
        Response::json(['ok' => true]);
    }
}
