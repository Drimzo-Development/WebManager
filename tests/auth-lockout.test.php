<?php
declare(strict_types=1);

// php tests/auth-lockout.test.php - sign-in throttling: per address and per account, known addresses are not locked out
require dirname(__DIR__) . '/app/bootstrap.php';

use WebManager\Http\Auth;

$fail = 0;
$check = function (string $label, bool $ok) use (&$fail): void {
    echo ($ok ? '  PASS  ' : '  FAIL  ') . $label . "\n";
    if (!$ok) {
        $fail = 1;
    }
};

$check('No failures: not locked', !Auth::lockedOut(0, 0, false));
$check('4 failures for the account: not locked', !Auth::lockedOut(0, 4, false));
$check('5 failures for the account from an unknown address: locked', Auth::lockedOut(0, 5, false));
$check('5 failures for the account from an address that signed in before: not locked', !Auth::lockedOut(0, 5, true));
$check('9 failures from one address: not locked', !Auth::lockedOut(9, 0, false));
$check('10 failures from one address: locked', Auth::lockedOut(10, 0, false));
$check('10 failures from a known address: still locked (limit per address)', Auth::lockedOut(10, 5, true));

exit($fail);
