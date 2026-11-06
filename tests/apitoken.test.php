<?php
declare(strict_types=1);

// php tests/apitoken.test.php - API tokens (format, role cap, IP lists) and the /api/v1 allowlist incl. its OpenAPI contract
require dirname(__DIR__) . '/app/bootstrap.php';

use WebManager\Http\ApiV1;
use WebManager\Http\Auth;
use WebManager\Support\ApiToken;

$fail = 0;
$check = function (string $label, bool $ok) use (&$fail): void {
    echo ($ok ? '  PASS  ' : '  FAIL  ') . $label . "\n";
    if (!$ok) {
        $fail = 1;
    }
};

// ---- token format
$t = ApiToken::generate();
$check('Token has the format wmt_<8 hex>_<43 characters>', preg_match('/^wmt_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/', $t['token']) === 1);
$p = ApiToken::parse($t['token']);
$check('parse() returns prefix and secret', $p !== null && $p['prefix'] === $t['prefix'] && hash('sha256', $p['secret']) === $t['hash']);
$check('Hash is SHA-256 (64 hex characters), the secret is not in it', strlen($t['hash']) === 64 && !str_contains($t['token'], $t['hash']));
$check('Two tokens differ', ApiToken::generate()['token'] !== $t['token']);
foreach (['', 'wmt_', 'Bearer x', 'wmt_zzzzzzzz_' . str_repeat('a', 43), 'wmt_0123abcd_' . str_repeat('a', 42), 'wmt_0123abcd_' . str_repeat('a', 44), 'wmt_0123abcd_' . str_repeat('!', 43), "wmt_0123abcd_" . str_repeat('a', 43) . "\n"] as $bad) {
    $check('parse() lehnt ab: ' . json_encode(substr($bad, 0, 24)), ApiToken::parse($bad) === null);
}

// ---- role cap: the lower role wins, an unknown role never grants more
$check('Admin mit viewer-Token = viewer', ApiToken::effectiveRole('admin', 'viewer') === 'viewer');
$check('Operator mit admin-Token = operator', ApiToken::effectiveRole('operator', 'admin') === 'operator');
$check('Same role stays', ApiToken::effectiveRole('operator', 'operator') === 'operator');
$check('Viewer with operator token = viewer', ApiToken::effectiveRole('viewer', 'operator') === 'viewer');
$check('An unknown role never wins (rank 0, passes no role check)', (Auth::ROLES[ApiToken::effectiveRole('admin', 'root')] ?? 0) === 0 && (Auth::ROLES[ApiToken::effectiveRole('root', 'admin')] ?? 0) === 0);

// ---- IP lists
$ip = static fn (string $list, string $addr): bool => ApiToken::ipAllowed($list, $addr);
$check('Empty list allows every address', $ip('', '203.0.113.9') && $ip('  ', '2001:db8::1'));
$check('Single address', $ip('203.0.113.9', '203.0.113.9') && !$ip('203.0.113.9', '203.0.113.10'));
$check('CIDR /24', $ip('203.0.113.0/24', '203.0.113.200') && !$ip('203.0.113.0/24', '203.0.114.1'));
$check('CIDR mit krummer Maske /20', $ip('10.0.16.0/20', '10.0.31.255') && !$ip('10.0.16.0/20', '10.0.32.0'));
$check('CIDR /32 and /0', $ip('203.0.113.9/32', '203.0.113.9') && !$ip('203.0.113.9/32', '203.0.113.8') && $ip('0.0.0.0/0', '198.51.100.1'));
$check('IPv6 and IPv6 CIDR', $ip('2001:db8::/32', '2001:db8:ffff::1') && !$ip('2001:db8::/32', '2001:db9::1') && $ip('2001:db8::1', '2001:db8::1'));
$check('IPv4 list does not apply to IPv6 and vice versa', !$ip('0.0.0.0/0', '2001:db8::1') && !$ip('::/0', '203.0.113.9'));
$check('Several entries, comma or space', $ip('198.51.100.1, 203.0.113.0/24 192.0.2.7', '192.0.2.7') && !$ip('198.51.100.1, 203.0.113.0/24', '192.0.2.7'));
$check('Invalid entry allows nothing', !$ip('nonsense', '203.0.113.9') && !$ip('203.0.113.0/abc', '203.0.113.9'));
$check('validIpList: valid lists', ApiToken::validIpList('') && ApiToken::validIpList('203.0.113.9, 2001:db8::/32 10.0.0.0/8'));
$check('validIpList: invalid', !ApiToken::validIpList('foo') && !ApiToken::validIpList('10.0.0.0/33') && !ApiToken::validIpList('::/129') && !ApiToken::validIpList('10.0.0.0/') && !ApiToken::validIpList('10.0.0.1/-1'));

// ---- /api/v1 allowlist
$r = static fn (string $m, string $p): ?string => ApiV1::resolve($m, $p);
$check('v1 prefix', ApiV1::isV1('/api/v1/me') && !ApiV1::isV1('/api/v10/me') && !ApiV1::isV1('/api/sites'));
$check('GET /me is served directly', $r('GET', '/api/v1/me') === '/api/v1/me');
$check('GET /metrics is served directly', $r('GET', '/api/v1/metrics') === '/api/v1/metrics' && $r('POST', '/api/v1/metrics') === null);
$check('GET /sites -> /api/overview', $r('GET', '/api/v1/sites') === '/api/overview');
$check('GET /sites/7 -> /api/sites/7', $r('GET', '/api/v1/sites/7') === '/api/sites/7');
foreach (['status', 'logs', 'metrics', 'jobs'] as $sub) {
    $check("GET /sites/7/$sub", $r('GET', "/api/v1/sites/7/$sub") === "/api/sites/7/$sub");
}
$check('POST /sites/7/action', $r('POST', '/api/v1/sites/7/action') === '/api/sites/7/action');
$check('Jobs: list, single, logs, cancel', $r('GET', '/api/v1/jobs') === '/api/jobs' && $r('GET', '/api/v1/jobs/3') === '/api/jobs/3' && $r('GET', '/api/v1/jobs/3/logs') === '/api/jobs/3/logs' && $r('POST', '/api/v1/jobs/3/cancel') === '/api/jobs/3/cancel');
$check('HEAD behaves like GET', $r('HEAD', '/api/v1/sites') === '/api/overview');
foreach ([
    ['DELETE', '/api/v1/sites/7'], ['PUT', '/api/v1/sites/7'], ['POST', '/api/v1/sites'], ['GET', '/api/v1/sites/7/env'], ['GET', '/api/v1/sites/7/files'],
    ['GET', '/api/v1/sites/7/database/password'], ['GET', '/api/v1/users'], ['GET', '/api/v1/audit'], ['GET', '/api/v1/system'], ['POST', '/api/v1/update/apply'],
    ['GET', '/api/v1/account'], ['GET', '/api/v1/account/tokens'], ['POST', '/api/v1/me'], ['GET', '/api/v1/sites/abc'], ['GET', '/api/v1/sites/7/'], ['GET', '/api/v1/sites/7/status/x'],
    ['GET', '/api/v1/sites/../users'], ['GET', '/api/v1/sites/7%2f..'], ['GET', '/api/v1/'], ['GET', '/api/v1'], ['POST', '/api/v1/jobs'], ['GET', '/api/v1/sites/7/action'],
] as [$m, $p]) {
    $check("not in v1: $m $p", $r($m, $p) === null);
}

// ---- contract: every v1 route is documented in docs/openapi.yaml and the other way round
$yaml = (string) file_get_contents(dirname(__DIR__) . '/docs/openapi.yaml');
$documented = [];
$path = null;
foreach (preg_split('/\R/', $yaml) ?: [] as $line) {
    if (preg_match('#^  (/api/v1/\S*):\s*$#', $line, $m)) {
        $path = $m[1];
    } elseif ($path !== null && preg_match('/^    (get|post|put|delete):\s*$/', $line, $m)) {
        $documented[] = strtoupper($m[1]) . ' ' . $path;
    } elseif (preg_match('/^\S/', $line)) {
        $path = null;
    }
}
$implemented = [];
foreach (ApiV1::routes() as [$method, $re]) {
    // turn '#^/api/v1/sites/(\d+)/(status|logs)$#' into one documentation style path per alternative
    $p = trim(substr($re, 2, -2), '^$');
    $p = (string) preg_replace('#\(\\\\d\+\)#', '{id}', $p);
    if (preg_match('#\(([a-z|]+)\)#', $p, $alt)) {
        foreach (explode('|', $alt[1]) as $a) {
            $implemented[] = $method . ' ' . str_replace($alt[0], $a, $p);
        }
    } else {
        $implemented[] = $method . ' ' . $p;
    }
}
sort($documented);
sort($implemented);
$check('OpenAPI and ApiV1::MAP describe the same ' . count($implemented) . ' routes', $documented === $implemented);
if ($documented !== $implemented) {
    echo '    only in OpenAPI: ' . implode(', ', array_diff($documented, $implemented)) . "\n    only in code: " . implode(', ', array_diff($implemented, $documented)) . "\n";
}

echo $fail ? "\nFAILED\n" : "\nAll checks passed.\n";
exit($fail);
