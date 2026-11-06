<?php
declare(strict_types=1);

// php tests/webauthn-rp.test.php - which domain/origin passkeys are bound to, and when they are unavailable (IP address, plain http)
define('WM_ROOT', dirname(__DIR__));
spl_autoload_register(static function (string $c): void {
    if (str_starts_with($c, 'WebManager\\')) {
        $f = WM_ROOT . '/app/' . str_replace('\\', '/', substr($c, strlen('WebManager\\'))) . '.php';
        if (is_file($f)) {
            require $f;
        }
    }
});

use WebManager\Controllers\AccountApi;
use WebManager\Http\Request;

function req(array $server): Request
{
    $r = (new ReflectionClass(Request::class))->newInstanceWithoutConstructor();
    $p = new ReflectionProperty(Request::class, 'server');
    $p->setAccessible(true);
    $p->setValue($r, $server);
    return $r;
}

$cases = [
    'https with domain' => [['HTTP_HOST' => 'panel.example.com', 'HTTPS' => 'on'], ['id' => 'panel.example.com', 'origin' => 'https://panel.example.com']],
    'behind the proxy (X-Forwarded-*)' => [['HTTP_HOST' => 'webmanager:8080', 'HTTP_X_FORWARDED_HOST' => 'Panel.Example.com', 'HTTP_X_FORWARDED_PROTO' => 'https'], ['id' => 'panel.example.com', 'origin' => 'https://panel.example.com']],
    'own port' => [['HTTP_HOST' => 'panel.example.com:8443', 'HTTPS' => 'on'], ['id' => 'panel.example.com', 'origin' => 'https://panel.example.com:8443']],
    'http with domain: not possible' => [['HTTP_HOST' => 'panel.example.com'], null],
    'https over IPv4: not possible' => [['HTTP_HOST' => '203.0.113.5', 'HTTPS' => 'on'], null],
    'https over IPv6: not possible' => [['HTTP_HOST' => '[2001:db8::1]', 'HTTPS' => 'on'], null],
    'localhost over http (tests)' => [['HTTP_HOST' => 'localhost:8080'], ['id' => 'localhost', 'origin' => 'http://localhost:8080']],
    'invalid characters in the host' => [['HTTP_HOST' => 'pa nel.example.com', 'HTTPS' => 'on'], null],
    // behind Pangolin: the scheme of this hop is http, the visitor's is https (X-Forwarded-Proto passed on by the proxy)
    'behind Pangolin (X-Forwarded-Proto: https)' => [['HTTP_HOST' => 'panel.example.com', 'HTTP_X_FORWARDED_PROTO' => 'https', 'HTTP_X_FORWARDED_HOST' => 'panel.example.com'], ['id' => 'panel.example.com', 'origin' => 'https://panel.example.com']],
    'behind Pangolin, but internally only http and without headers' => [['HTTP_HOST' => 'panel.example.com'], null],
    // configured public address wins over everything the request says
    'configured address (Pangolin without headers)' => [['HTTP_HOST' => '10.0.0.5:8080'], ['id' => 'panel.example.com', 'origin' => 'https://panel.example.com'], 'https://panel.example.com'],
    'configured address wins over a forged host' => [['HTTP_HOST' => 'evil.example', 'HTTPS' => 'on', 'HTTP_X_FORWARDED_HOST' => 'evil.example'], ['id' => 'panel.example.com', 'origin' => 'https://panel.example.com'], 'https://panel.example.com'],
    'configured address with port' => [['HTTP_HOST' => 'x'], ['id' => 'panel.example.com', 'origin' => 'https://panel.example.com:8443'], 'https://panel.example.com:8443'],
];
$fail = 0;
foreach ($cases as $name => $case) {
    [$server, $want] = $case;
    $got = AccountApi::rpFrom(req($server), $case[2] ?? '');
    $ok = $got === $want;
    echo ($ok ? '  PASS  ' : '  FAIL  ') . $name . ($ok ? '' : ' => ' . json_encode($got)) . "\n";
    $fail |= $ok ? 0 : 1;
}
exit($fail);
