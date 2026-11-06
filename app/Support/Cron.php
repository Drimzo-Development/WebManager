<?php
declare(strict_types=1);

namespace WebManager\Support;

/**
 * Validation of cron expressions ("min hour day-of-month month day-of-week", lists, ranges, steps, @hourly/@daily/@midnight/@weekly/@monthly).
 * The worker (workers/src/cron.js) evaluates them with the same rules; the next run time is only ever computed there.
 */
final class Cron
{
    private const ALIASES = ['@hourly', '@daily', '@midnight', '@weekly', '@monthly'];
    private const FIELDS = [['Minute', 0, 59], ['Hour', 0, 23], ['Day', 1, 31], ['Month', 1, 12], ['Weekday', 0, 7]];

    /** Returns null when the expression is valid, otherwise a readable error. */
    public static function validate(string $expr): ?string
    {
        $expr = trim($expr);
        if (in_array(strtolower($expr), self::ALIASES, true)) {
            return null;
        }
        $parts = preg_split('/\s+/', $expr) ?: [];
        if (count($parts) !== 5) {
            return 'Expected five fields: minute hour day month weekday (or @hourly, @daily, @weekly, @monthly).';
        }
        foreach ($parts as $i => $part) {
            [$name, $min, $max] = self::FIELDS[$i];
            foreach (explode(',', $part) as $item) {
                if (!preg_match('/^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/', $item, $m)) {
                    return "$name: invalid expression “{$item}”.";
                }
                if (isset($m[2]) && (int) $m[2] < 1) {
                    return "$name: The step must be at least 1.";
                }
                if ($m[1] === '*') {
                    continue;
                }
                $bounds = array_map('intval', explode('-', $m[1]));
                $from = $bounds[0];
                $to = $bounds[1] ?? (isset($m[2]) ? $max : $from);
                if ($from < $min || $to > $max || $from > $to) {
                    return "$name: The value must be between $min and $max.";
                }
            }
        }
        return null;
    }
}
