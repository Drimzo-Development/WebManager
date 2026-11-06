<?php
declare(strict_types=1);

// php tests/cron.test.php - validation of cron expressions (same rules as workers/src/cron.js)
require dirname(__DIR__) . '/app/Support/Cron.php';

use WebManager\Support\Cron;

$fail = 0;
$check = function (string $label, bool $ok) use (&$fail): void {
    echo ($ok ? '  PASS  ' : '  FAIL  ') . $label . "\n";
    if (!$ok) {
        $fail = 1;
    }
};

foreach (['* * * * *', '*/15 * * * *', '0 3 * * *', '30 2 * * 1', '0 0 1 * *', '5,35 8-10 * * *', '10-30/10 * * * *', '0 12 * * 7', '0 0 29 2 *', '@hourly', '@DAILY', '@weekly', '@monthly', '@midnight', '  0   3 *  *  *  '] as $ok) {
    $check("valid: $ok", Cron::validate($ok) === null);
}
foreach (['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', 'a b c d e', '5-1 * * * *', '@yearly', '1,,2 * * * *', '; rm -rf / * * * *', '0 3 * * * ; reboot', "0 3 * * *\n0 4 * * *"] as $bad) {
    $check('unvalid: ' . json_encode($bad), Cron::validate($bad) !== null);
}
exit($fail);
