<?php
declare(strict_types=1);

// php tests/maintenance.test.php   (no database: the rule for maintenance windows; the worker has the same cases in workers/test/maintenance.test.js)
require dirname(__DIR__) . '/app/bootstrap.php';

use WebManager\Support\Maintenance as M;

$fails = 0;
function check(string $name, bool $ok): void
{
    global $fails;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    $fails += $ok ? 0 : 1;
}
$T = static fn (string $s): int => (int) strtotime($s . ' UTC');

$one = ['starts' => $T('2026-11-10 22:00:00'), 'ends' => $T('2026-11-11 02:00:00'), 'repeat' => 'none'];
check('one-off: before start', M::currentStart($one, $T('2026-11-10 21:59:59')) === null);
check('one-off: at start and just before the end', M::currentStart($one, $one['starts']) === $one['starts'] && M::currentStart($one, $T('2026-11-11 01:59:59')) === $one['starts']);
check('one-off: end is excluded', M::currentStart($one, $one['ends']) === null);

$daily = ['repeat' => 'daily'] + $one;
check('daily: recurs', M::currentStart($daily, $T('2026-11-13 01:00:00')) === $T('2026-11-12 22:00:00') && M::currentStart($daily, $T('2026-11-13 12:00:00')) === null);
check('daily: not before the first start', M::currentStart($daily, $T('2026-11-09 23:00:00')) === null);
$weekly = ['starts' => $T('2026-11-10 03:00:00'), 'ends' => $T('2026-11-10 04:00:00'), 'repeat' => 'weekly'];
check('weekly: only on its weekday', M::currentStart($weekly, $T('2026-11-17 03:30:00')) === $T('2026-11-17 03:00:00') && M::currentStart($weekly, $T('2026-11-18 03:30:00')) === null);

check('next start: upcoming, running, over', M::nextStart($one, $T('2026-11-01 00:00:00')) === $one['starts'] && M::nextStart($one, $T('2026-11-10 23:00:00')) === $one['starts'] && M::nextStart($one, $T('2026-11-12 00:00:00')) === null);
check('next start: repeating', M::nextStart($daily, $T('2026-11-13 12:00:00')) === $T('2026-11-13 22:00:00') && M::nextStart($weekly, $T('2026-11-11 00:00:00')) === $T('2026-11-17 03:00:00'));

check('valid windows', M::validate($one) === null && M::validate($daily) === null && M::validate($weekly) === null);
check('end must follow the start', M::validate(['ends' => $one['starts']] + $one) !== null && M::validate(['ends' => $one['starts'] - 3600] + $one) !== null);
check('at most 14 days', M::validate(['ends' => $one['starts'] + 14 * 86400 + 1] + $one) !== null && M::validate(['ends' => $one['starts'] + 14 * 86400] + $one) === null);
check('repeating window shorter than its repetition', M::validate(['ends' => $one['starts'] + 86400, 'repeat' => 'daily'] + $one) !== null && M::validate(['ends' => $one['starts'] + 86400 - 60, 'repeat' => 'daily'] + $one) === null);
check('unknown repetition refused', M::validate(['repeat' => 'monthly'] + $one) !== null);

exit($fails > 0 ? 1 : 0);
