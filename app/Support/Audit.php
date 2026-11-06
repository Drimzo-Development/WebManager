<?php
declare(strict_types=1);

namespace WebManager\Support;

use WebManager\Http\Auth;

final class Audit
{
    /** @param array<string,mixed> $details never put secrets in here */
    public static function log(string $action, string $target = '', array $details = [], ?int $userId = -1): void
    {
        try {
            $user = Auth::user();
            $uid = $userId === -1 ? ($user['id'] ?? null) : $userId;
            $actor = $user['email'] ?? '';
            $ip = $details['ip'] ?? ($_SERVER['REMOTE_ADDR'] ?? '');
            if (Auth::tokenId() !== null) {
                $details['api_token'] = Auth::tokenId();
            }
            Db::exec(
                'INSERT INTO audit_log (user_id, actor, action, target, ip, details) VALUES (?, ?, ?, ?, ?, ?)',
                [$uid, mb_substr($actor, 0, 190), mb_substr($action, 0, 80), mb_substr($target, 0, 190), mb_substr((string) $ip, 0, 45), json_encode($details, JSON_UNESCAPED_UNICODE) ?: '{}']
            );
        } catch (\Throwable $e) {
            error_log('audit failed: ' . $e->getMessage());
        }
    }
}
