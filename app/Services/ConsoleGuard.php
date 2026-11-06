<?php
declare(strict_types=1);

namespace WebManager\Services;

/**
 * Ends running web console sessions when the right to them goes away (sign-out, role change, deactivation, deletion, password
 * change, switching the console off). Best effort: a failing agent never blocks the action that triggered it; the worker's sweep
 * ends the sessions of accounts that are no longer active administrators as a backstop.
 */
final class ConsoleGuard
{
    public static function endUser(int $userId, string $reason): void
    {
        if ($userId > 0) {
            self::call('/v1/console/end-user', ['userId' => $userId, 'reason' => $reason]);
        }
    }

    public static function endSite(int $siteId): void
    {
        if ($siteId > 0) {
            self::call('/v1/console/end-site', ['siteId' => $siteId]);
        }
    }

    /** @param array<string,mixed> $body */
    private static function call(string $path, array $body): void
    {
        try {
            Agent::request('POST', $path, $body, null, 3);
        } catch (\Throwable $e) {
            error_log('console sessions could not be ended: ' . $e->getMessage());
        }
    }
}
