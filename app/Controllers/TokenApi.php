<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\Auth;
use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Support\ApiToken;
use WebManager\Support\Audit;
use WebManager\Support\Db;

/** Personal API tokens of the signed-in user. Session only (never reachable with a token). */
final class TokenApi
{
    /** @return array{id:int,email:string,name:string,role:string} */
    private static function owner(): array
    {
        $u = Auth::user();
        if ($u === null || Auth::viaToken()) {
            throw new HttpException(403, 'API tokens can only be managed in a signed-in session.');
        }
        return $u;
    }

    private static function iso(?string $dt): ?string
    {
        return $dt === null ? null : str_replace(' ', 'T', $dt) . 'Z';
    }

    /** @param array<string,mixed> $r */
    private static function present(array $r): array
    {
        return [
            'id' => (int) $r['id'], 'name' => $r['name'], 'prefix' => 'wmt_' . $r['prefix'], 'role' => $r['role'],
            'ip_allow' => $r['ip_allow'], 'created_at' => self::iso((string) $r['created_at']), 'expires_at' => self::iso((string) $r['expires_at']),
            'expired' => strtotime((string) $r['expires_at'] . ' UTC') <= time(),
            'last_used_at' => self::iso($r['last_used_at'] !== null ? (string) $r['last_used_at'] : null), 'last_used_ip' => $r['last_used_ip'],
        ];
    }

    public static function list(Request $req): never
    {
        $u = self::owner();
        $rows = Db::all('SELECT * FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC', [$u['id']]);
        Response::json(['tokens' => array_map([self::class, 'present'], $rows), 'max' => ApiToken::MAX_PER_USER]);
    }

    public static function create(Request $req): never
    {
        $u = self::owner();
        $in = $req->json();
        $name = trim((string) ($in['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > 80) {
            throw new HttpException(422, 'Please enter a name of 1 to 80 characters.');
        }
        $role = (string) ($in['role'] ?? 'viewer');
        if (!in_array($role, ['viewer', 'operator', 'admin'], true)) {
            throw new HttpException(422, 'Unknown role.');
        }
        if ((Auth::ROLES[$role] ?? 99) > (Auth::ROLES[$u['role']] ?? 0)) {
            throw new HttpException(403, 'A token cannot have more permissions than your own account.');
        }
        $days = (int) ($in['expires_days'] ?? ApiToken::DEFAULT_DAYS);
        if ($days < 1 || $days > ApiToken::MAX_DAYS) {
            throw new HttpException(422, 'The validity must be between 1 and ' . ApiToken::MAX_DAYS . ' days.');
        }
        $ips = trim((string) ($in['ip_allow'] ?? ''));
        if (strlen($ips) > 500 || !ApiToken::validIpList($ips)) {
            throw new HttpException(422, 'Invalid IP list. Addresses and CIDR ranges are allowed, separated by commas or spaces.');
        }
        $active = (int) Db::val('SELECT COUNT(*) FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW()', [$u['id']]);
        if ($active >= ApiToken::MAX_PER_USER) {
            throw new HttpException(409, 'At most ' . ApiToken::MAX_PER_USER . ' active tokens are allowed. Please revoke an old one first.');
        }
        $t = ApiToken::generate();
        $id = Db::insert(
            'INSERT INTO api_tokens (user_id, name, prefix, token_hash, role, ip_allow, expires_at) VALUES (?, ?, ?, ?, ?, ?, NOW() + INTERVAL ? DAY)',
            [$u['id'], $name, $t['prefix'], $t['hash'], $role, $ips, $days]
        );
        Audit::log('token.create', 'wmt_' . $t['prefix'], ['name' => $name, 'role' => $role, 'days' => $days]);
        $row = Db::one('SELECT * FROM api_tokens WHERE id = ?', [$id]);
        // the secret is part of this answer only; it cannot be shown again
        Response::json(['token' => $t['token'], 'item' => self::present($row ?? [])], 201);
    }

    public static function revoke(Request $req, array $p): never
    {
        $u = self::owner();
        $id = (int) ($p['id'] ?? 0);
        $row = Db::one('SELECT prefix FROM api_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [$id, $u['id']]);
        if ($row === null) {
            throw new HttpException(404, 'Token not found');
        }
        Db::exec('UPDATE api_tokens SET revoked_at = NOW() WHERE id = ? AND user_id = ?', [$id, $u['id']]);
        Audit::log('token.revoke', 'wmt_' . $row['prefix']);
        Response::json(['ok' => true]);
    }
}
