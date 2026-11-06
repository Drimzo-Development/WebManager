<?php
declare(strict_types=1);

// php tests/files.test.php   (no database: name and path checks of the file API for several files)
require dirname(__DIR__) . '/app/bootstrap.php';

use WebManager\Controllers\FileApi;
use WebManager\Http\HttpException;

$fails = 0;
function check(string $name, bool $ok): void
{
    global $fails;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    $fails += $ok ? 0 : 1;
}
$call = static function (string $method, mixed ...$args): mixed {
    $m = new ReflectionMethod(FileApi::class, $method);
    $m->setAccessible(true);
    return $m->invoke(null, ...$args);
};
$refused = static function (callable $f): bool {
    try {
        $f();
    } catch (HttpException) {
        return true;
    }
    return false;
};

foreach (['a', 'index.php', '.env', 'a b', 'ü.txt', str_repeat('x', 255)] as $ok) {
    check('valid name: ' . json_encode(mb_substr($ok, 0, 12)), $call('validName', $ok) === true);
}
foreach (['', '.', '..', 'a/b', 'a\\b', "a\0b", "a\nb", str_repeat('x', 256)] as $bad) {
    check('invalid name: ' . json_encode(mb_substr($bad, 0, 12)), $call('validName', $bad) === false);
}

check('names: duplicates are merged, order kept', $call('names', ['b', 'a', 'b'], 10) === ['b', 'a']);
check('names: empty, too many, not a list or a path are refused', $refused(static fn () => $call('names', [], 10)) && $refused(static fn () => $call('names', ['a', 'b', 'c'], 2))
    && $refused(static fn () => $call('names', 'a', 10)) && $refused(static fn () => $call('names', null, 10)) && $refused(static fn () => $call('names', ['a/b'], 10))
    && $refused(static fn () => $call('names', ['..'], 10)) && $refused(static fn () => $call('names', [5], 10)));

check('dir: slashes at the ends are removed', $call('dir', '/public/img/') === 'public/img' && $call('dir', '') === '' && $call('dir', null) === '');
foreach (['..', 'a/../b', '../x', 'a/..'] as $bad) {
    check('dir refused: ' . $bad, $refused(static fn () => $call('dir', $bad)));
}
check('dir refused: NUL and a very long path', $refused(static fn () => $call('dir', "a\0b")) && $refused(static fn () => $call('dir', str_repeat('a', 2049))));
check('join', $call('join', '', 'a') === 'a' && $call('join', 'x/y', 'a') === 'x/y/a');

exit($fails > 0 ? 1 : 0);
