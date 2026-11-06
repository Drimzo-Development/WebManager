<?php
declare(strict_types=1);

namespace WebManager\Support;

use WebManager\Http\Auth;
use WebManager\Http\HttpException;
use WebManager\Http\Request;

/**
 * Personal API tokens for /api/v1. Format: wmt_<8 hex prefix>_<43 character secret>.
 * The prefix identifies the row, only the SHA-256 of the secret is stored (the secret has 256 bits, a slow hash adds nothing).
 * A token never exceeds the role of its user, expires (at most after 365 days) and can be limited to IP addresses.
 */
final class ApiToken
{
    public const MAX_PER_USER = 20;
    public const MAX_DAYS = 365;
    public const DEFAULT_DAYS = 90;
    // D: "$" must not match before a trailing newline
    private const PATTERN = '/^wmt_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/D';

    /** @return array{token:string,prefix:string,hash:string} */
    public static function generate(): array
    {
        $prefix = bin2hex(random_bytes(4));
        $secret = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        return ['token' => "wmt_{$prefix}_{$secret}", 'prefix' => $prefix, 'hash' => hash('sha256', $secret)];
    }

    /** Revokes every active token of a user (an administrator reset the password: a stolen token must not outlive that). Returns how many. */
    public static function revokeAll(int $userId): int
    {
        return Db::exec('UPDATE api_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [$userId]);
    }

    /** @return array{prefix:string,secret:string}|null */
    public static function parse(string $token): ?array
    {
        return preg_match(self::PATTERN, $token, $m) === 1 ? ['prefix' => $m[1], 'secret' => $m[2]] : null;
    }

    public static function bearer(Request $req): ?string
    {
        $h = $req->header('Authorization');
        return preg_match('/^Bearer\s+(\S+)$/i', $h, $m) === 1 ? $m[1] : null;
    }

    /** The lower of two roles; an unknown role falls back to the lowest valid one. */
    public static function effectiveRole(string $userRole, string $tokenRole): string
    {
        $a = Auth::ROLES[$userRole] ?? 0;
        $b = Auth::ROLES[$tokenRole] ?? 0;
        return $a <= $b ? $userRole : $tokenRole;
    }

    /** True when $ip is covered by the comma/space separated list of addresses and CIDR ranges (empty list = everybody). */
    public static function ipAllowed(string $list, string $ip): bool
    {
        $items = preg_split('/[\s,]+/', trim($list), -1, PREG_SPLIT_NO_EMPTY) ?: [];
        if ($items === []) {
            return true;
        }
        foreach ($items as $item) {
            if (self::inRange($item, $ip)) {
                return true;
            }
        }
        return false;
    }

    public static function validIpList(string $list): bool
    {
        foreach (preg_split('/[\s,]+/', trim($list), -1, PREG_SPLIT_NO_EMPTY) ?: [] as $item) {
            $bits = null;
            $addr = $item;
            if (str_contains($item, '/')) {
                [$addr, $bits] = explode('/', $item, 2);
                if (!ctype_digit($bits)) {
                    return false;
                }
            }
            $bin = filter_var($addr, FILTER_VALIDATE_IP) ? inet_pton($addr) : false;
            if ($bin === false || ($bits !== null && (int) $bits > strlen($bin) * 8)) {
                return false;
            }
        }
        return true;
    }

    private static function inRange(string $range, string $ip): bool
    {
        [$addr, $bits] = array_pad(explode('/', $range, 2), 2, null);
        $a = filter_var($addr, FILTER_VALIDATE_IP) ? inet_pton($addr) : false;
        $b = filter_var($ip, FILTER_VALIDATE_IP) ? inet_pton($ip) : false;
        if ($a === false || $b === false || strlen($a) !== strlen($b)) {
            return false;
        }
        // a malformed prefix length must never widen the range (fail closed)
        if ($bits !== null && (!ctype_digit($bits) || (int) $bits > strlen($a) * 8)) {
            return false;
        }
        $n = $bits === null ? strlen($a) * 8 : (int) $bits;
        $full = intdiv($n, 8);
        if (substr($a, 0, $full) !== substr($b, 0, $full)) {
            return false;
        }
        $rest = $n % 8;
        if ($rest === 0) {
            return true;
        }
        $mask = (0xFF << (8 - $rest)) & 0xFF;
        return (ord($a[$full]) & $mask) === (ord($b[$full]) & $mask);
    }

    /**
     * Checks the Bearer token of a request and returns the acting user (role already capped) or throws 401/429.
     * @return array{id:int,email:string,name:string,role:string,token_id:int}
     */
    public static function authenticate(Request $req, string $token): array
    {
        $ip = $req->ip();
        $fails = (int) Db::val("SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND email = 'api-token' AND success = 0 AND created_at > NOW() - INTERVAL 15 MINUTE", [$ip]);
        if ($fails >= 20) {
            throw new HttpException(429, 'Too many invalid tokens. Please try again later.');
        }
        $parsed = self::parse($token);
        $row = $parsed ? Db::one(
            'SELECT t.id, t.user_id, t.token_hash, t.role AS token_role, t.ip_allow, t.expires_at, t.revoked_at, u.email, u.name, u.role AS user_role, u.active '
            . 'FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.prefix = ?',
            [$parsed['prefix']]
        ) : null;
        // always compare something, so unknown prefixes cost the same as wrong secrets
        $expected = $row['token_hash'] ?? hash('sha256', 'unknown');
        $match = hash_equals($expected, hash('sha256', $parsed['secret'] ?? ''));
        $ok = $row !== null && $match && $row['revoked_at'] === null && (int) $row['active'] === 1
            && strtotime((string) $row['expires_at'] . ' UTC') > time() && isset(Auth::ROLES[(string) ($row['user_role'] ?? '')])
            && self::ipAllowed((string) $row['ip_allow'], $ip);
        if (!$ok) {
            Db::exec("INSERT INTO login_attempts (ip, email, success) VALUES (?, 'api-token', 0)", [$ip]);
            header('WWW-Authenticate: Bearer realm="webmanager", error="invalid_token"');
            throw new HttpException(401, 'Invalid, expired or revoked token.');
        }
        // last-used is informational; refresh at most once a minute so reads stay cheap
        Db::exec('UPDATE api_tokens SET last_used_at = NOW(), last_used_ip = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL 1 MINUTE)', [$ip, $row['id']]);
        return [
            'id' => (int) $row['user_id'],
            'email' => (string) $row['email'],
            'name' => (string) $row['name'],
            'role' => self::effectiveRole((string) $row['user_role'], (string) $row['token_role']),
            'token_id' => (int) $row['id'],
        ];
    }
}
