<?php
declare(strict_types=1);

namespace WebManager\Support;

/**
 * Maintenance windows (times in UTC). A window is [starts_at, ends_at) and may repeat every day or week with the same length.
 * The worker (workers/src/maintenance.js) uses the same rule to mute notifications.
 */
final class Maintenance
{
    public const PERIOD = ['daily' => 86400, 'weekly' => 604800];
    public const MAX_SECONDS = 14 * 86400;

    /** Start of the occurrence that contains $now, or null when no occurrence is running. @param array{starts:int,ends:int,repeat:string} $w */
    public static function currentStart(array $w, int $now): ?int
    {
        if ($now < $w['starts']) {
            return null;
        }
        $len = $w['ends'] - $w['starts'];
        $period = self::PERIOD[$w['repeat']] ?? null;
        $start = $period === null ? $w['starts'] : $w['starts'] + intdiv($now - $w['starts'], $period) * $period;
        return $now < $start + $len ? $start : null;
    }

    /** Next start after $now (or the running one's start), null when a one-off window is over. @param array{starts:int,ends:int,repeat:string} $w */
    public static function nextStart(array $w, int $now): ?int
    {
        if ($now < $w['starts']) {
            return $w['starts'];
        }
        $period = self::PERIOD[$w['repeat']] ?? null;
        if ($period === null) {
            return $now < $w['ends'] ? $w['starts'] : null;
        }
        $cur = self::currentStart($w, $now);
        return $cur ?? $w['starts'] + (intdiv($now - $w['starts'], $period) + 1) * $period;
    }

    /** Error text or null. @param array{starts:int,ends:int,repeat:string} $w */
    public static function validate(array $w): ?string
    {
        if (!isset(['none' => 1, 'daily' => 1, 'weekly' => 1][$w['repeat']])) {
            return 'Unknown repetition.';
        }
        $len = $w['ends'] - $w['starts'];
        if ($len < 60) {
            return 'The end must be at least one minute after the start.';
        }
        if ($len > self::MAX_SECONDS) {
            return 'A window can last 14 days at most.';
        }
        $period = self::PERIOD[$w['repeat']] ?? null;
        if ($period !== null && $len >= $period) {
            return 'A repeating window must be shorter than its repetition.';
        }
        return null;
    }
}
