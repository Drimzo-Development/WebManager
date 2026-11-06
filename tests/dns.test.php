<?php
declare(strict_types=1);

// php tests/dns.test.php   (no database: wildcard domains and who may reach the DNS provider settings)
require dirname(__DIR__) . '/app/bootstrap.php';

use WebManager\Http\HttpException;
use WebManager\Http\Permissions;
use WebManager\Services\SiteService;

$fails = 0;
function check(string $name, bool $ok): void
{
    global $fails;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    $fails += $ok ? 0 : 1;
}
$refused = static function (callable $f): bool {
    try {
        $f();
    } catch (HttpException) {
        return true;
    }
    return false;
};

check('plain domain', SiteService::normalizeDomain('Example.COM.') === 'example.com');
check('wildcard is refused by default (dashboard domain)', $refused(static fn () => SiteService::normalizeDomain('*.example.com')));
check('wildcard accepted where allowed', SiteService::normalizeDomain('*.Example.com', true) === '*.example.com');
foreach (['*.*.example.com', 'a.*.example.com', '*example.com', '*.', '*', '*.com', '*. example.com'] as $bad) {
    check('refused: ' . json_encode($bad), $refused(static fn () => SiteService::normalizeDomain($bad, true)));
}

check('operators may see whether a provider is connected', Permissions::required('GET', '/api/dns') === 'operator');
foreach ([['PUT', '/api/dns'], ['DELETE', '/api/dns'], ['POST', '/api/dns/test']] as [$m, $p]) {
    check("administrators only: $m $p", Permissions::required($m, $p) === 'admin');
}
check('operators may set the DNS records of their website', Permissions::required('POST', '/api/sites/7/dns-records') === 'operator');

exit($fails > 0 ? 1 : 0);
