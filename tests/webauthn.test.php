<?php
declare(strict_types=1);

// php tests/webauthn.test.php - passkey verification against a simulated authenticator (generated EC/RSA keys, own CBOR encoder)
require dirname(__DIR__) . '/app/Support/Cbor.php';
require dirname(__DIR__) . '/app/Support/WebAuthn.php';

// Windows PHP builds do not find their openssl.cnf on their own: key generation then needs an explicit config file
$cnf = getenv('OPENSSL_CONF') ?: '';
foreach (['C:/php/extras/ssl/openssl.cnf', '/etc/ssl/openssl.cnf'] as $candidate) {
    if ($cnf === '' && is_file($candidate)) {
        $cnf = $candidate;
    }
}
define('KEYGEN_CNF', $cnf);

use WebManager\Support\Cbor;
use WebManager\Support\WebAuthn;

$fail = 0;
$check = function (string $label, bool $ok) use (&$fail): void {
    echo ($ok ? '  PASS  ' : '  FAIL  ') . $label . "\n";
    if (!$ok) {
        $fail = 1;
    }
};
$throws = function (callable $fn, string $needle = ''): bool {
    try {
        $fn();
    } catch (\RuntimeException $e) {
        return $needle === '' || str_contains($e->getMessage(), $needle);
    }
    return false;
};

// ---- minimal CBOR encoder (test only)
function cbor(mixed $v): string
{
    $head = static function (int $major, int $n): string {
        if ($n < 24) {
            return chr(($major << 5) | $n);
        }
        if ($n < 256) {
            return chr(($major << 5) | 24) . chr($n);
        }
        if ($n < 65536) {
            return chr(($major << 5) | 25) . pack('n', $n);
        }
        return chr(($major << 5) | 26) . pack('N', $n);
    };
    if (is_int($v)) {
        return $v >= 0 ? $head(0, $v) : $head(1, -1 - $v);
    }
    if (is_bool($v)) {
        return chr(0xe0 | ($v ? 21 : 20));
    }
    if ($v === null) {
        return chr(0xf6);
    }
    if (is_string($v)) {
        return str_starts_with($v, "\x00bin:") ? $head(2, strlen($v) - 5) . substr($v, 5) : $head(3, strlen($v)) . $v;
    }
    if (is_array($v)) {
        if (array_is_list($v)) {
            return $head(4, count($v)) . implode('', array_map('cbor', $v));
        }
        $out = $head(5, count($v));
        foreach ($v as $k => $x) {
            $out .= cbor($k) . cbor($x);
        }
        return $out;
    }
    throw new \InvalidArgumentException('type');
}
function bin(string $b): string
{
    return "\x00bin:" . $b;
}

// ---- simulated authenticator
$rpId = 'panel.example.com';
$origin = 'https://panel.example.com';
function makeKey(string $kind): array
{
    if ($kind === 'es256') {
        $k = openssl_pkey_new(array_filter(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1', 'config' => KEYGEN_CNF ?: null]));
        $d = openssl_pkey_get_details($k)['ec'];
        $cose = [1 => 2, 3 => -7, -1 => 1, -2 => bin(str_pad($d['x'], 32, "\x00", STR_PAD_LEFT)), -3 => bin(str_pad($d['y'], 32, "\x00", STR_PAD_LEFT))];
    } else {
        $k = openssl_pkey_new(array_filter(['private_key_type' => OPENSSL_KEYTYPE_RSA, 'private_key_bits' => 2048, 'config' => KEYGEN_CNF ?: null]));
        $d = openssl_pkey_get_details($k)['rsa'];
        $cose = [1 => 3, 3 => -257, -1 => bin($d['n']), -2 => bin($d['e'])];
    }
    return ['key' => $k, 'cose' => $cose];
}
function clientData(string $type, string $challenge, string $origin, array $extra = []): string
{
    return json_encode(array_merge(['type' => $type, 'challenge' => WebAuthn::b64uEncode($challenge), 'origin' => $origin, 'crossOrigin' => false], $extra), JSON_UNESCAPED_SLASHES);
}
function registration(array $a, string $rp, string $credId, int $flags = 0x45, int $count = 0, string $fmt = 'none'): string
{
    $ad = hash('sha256', $rp, true) . chr($flags) . pack('N', $count) . str_repeat("\x00", 16) . pack('n', strlen($credId)) . $credId . cbor($a['cose']);
    return cbor(['fmt' => $fmt, 'attStmt' => [], 'authData' => bin($ad)]);
}
function assertion(array $a, string $rp, string $clientData, int $flags = 0x05, int $count = 1): array
{
    $ad = hash('sha256', $rp, true) . chr($flags) . pack('N', $count);
    openssl_sign($ad . hash('sha256', $clientData, true), $sig, $a['key'], OPENSSL_ALGO_SHA256);
    return [$ad, $sig];
}

foreach (['es256', 'rsa'] as $kind) {
    $a = makeKey($kind);
    $label = $kind === 'es256' ? 'ES256' : 'RS256';
    $cred = random_bytes(32);
    $ch = random_bytes(32);

    $reg = WebAuthn::verifyRegistration(clientData('webauthn.create', $ch, $origin), registration($a, $rpId, $cred), $ch, $rpId, [$origin]);
    $check("$label: registration is accepted", $reg['id'] === $cred && $reg['alg'] === ($kind === 'es256' ? -7 : -257) && $reg['uv'] === true);

    $ch2 = random_bytes(32);
    $cd = clientData('webauthn.get', $ch2, $origin);
    [$ad, $sig] = assertion($a, $rpId, $cd);
    $res = WebAuthn::verifyAssertion($cd, $ad, $sig, $ch2, $rpId, [$origin], $reg['cose'], 0);
    $check("$label: sign-in is accepted, counter is adopted", $res['signCount'] === 1 && $res['uv'] === true);

    $check("$label: wrong challenge", $throws(fn () => WebAuthn::verifyAssertion($cd, $ad, $sig, random_bytes(32), $rpId, [$origin], $reg['cose'], 0), 'expired'));
    $check("$label: wrong origin", $throws(fn () => WebAuthn::verifyAssertion(clientData('webauthn.get', $ch2, 'https://evil.example'), $ad, $sig, $ch2, $rpId, [$origin], $reg['cose'], 0), 'origin'));
    $check("$label: wrong type (create instead of get)", $throws(fn () => WebAuthn::verifyAssertion(clientData('webauthn.create', $ch2, $origin), $ad, $sig, $ch2, $rpId, [$origin], $reg['cose'], 0), 'client data'));
    $check("$label: falsche Domain (rpId)", $throws(fn () => WebAuthn::verifyAssertion($cd, $ad, $sig, $ch2, 'anders.example.com', [$origin], $reg['cose'], 0), 'domain'));
    $bad = $sig;
    $bad[strlen($bad) - 1] = chr(ord($bad[strlen($bad) - 1]) ^ 1);
    $check("$label: forged signature", $throws(fn () => WebAuthn::verifyAssertion($cd, $ad, $bad, $ch2, $rpId, [$origin], $reg['cose'], 0), 'signature'));
    $ad2 = $ad;
    $ad2[36] = chr(9);
    $check("$label: modified authenticator data", $throws(fn () => WebAuthn::verifyAssertion($cd, $ad2, $sig, $ch2, $rpId, [$origin], $reg['cose'], 0), 'signature'));
    [$adNoUp, $sigNoUp] = assertion($a, $rpId, $cd, 0x00);
    $check("$label: without presence flag", $throws(fn () => WebAuthn::verifyAssertion($cd, $adNoUp, $sigNoUp, $ch2, $rpId, [$origin], $reg['cose'], 0), 'presence'));
    $check("$label: signature counter must not go back", $throws(fn () => WebAuthn::verifyAssertion($cd, $ad, $sig, $ch2, $rpId, [$origin], $reg['cose'], 5), 'counter'));
    [$ad0, $sig0] = assertion($a, $rpId, $cd, 0x05, 0);
    $check("$label: counter 0/0 (authenticator without counter) is allowed", WebAuthn::verifyAssertion($cd, $ad0, $sig0, $ch2, $rpId, [$origin], $reg['cose'], 0)['signCount'] === 0);
    [$adUv, $sigUv] = assertion($a, $rpId, $cd, 0x05);
    [$adNoUv, $sigNoUv] = assertion($a, $rpId, $cd, 0x01);
    $check("$label: passwordless sign-in requires user verification (UV)", WebAuthn::verifyAssertion($cd, $adUv, $sigUv, $ch2, $rpId, [$origin], $reg['cose'], 0, true)['uv'] === true
        && $throws(fn () => WebAuthn::verifyAssertion($cd, $adNoUv, $sigNoUv, $ch2, $rpId, [$origin], $reg['cose'], 0, true), 'fingerprint')
        && WebAuthn::verifyAssertion($cd, $adNoUv, $sigNoUv, $ch2, $rpId, [$origin], $reg['cose'], 0, false)['uv'] === false);
    $other = makeKey($kind);
    $o = 0;
    $check("$label: signature of another key", $throws(function () use ($other, $rpId, $cd, $ch2, $origin, $reg) {
        [$adX, $sigX] = assertion($other, $rpId, $cd);
        WebAuthn::verifyAssertion($cd, $adX, $sigX, $ch2, $rpId, [$origin], $reg['cose'], 0);
    }, 'signature'));
}

// ---- registration refusals
$a = makeKey('es256');
$cred = random_bytes(16);
$ch = random_bytes(32);
$cdr = clientData('webauthn.create', $ch, $origin);
$check('registration: attestation other than none', $throws(fn () => WebAuthn::verifyRegistration($cdr, registration($a, $rpId, $cred, 0x45, 0, 'packed'), $ch, $rpId, [$origin]), 'attestation'));
$check('registration: without presence', $throws(fn () => WebAuthn::verifyRegistration($cdr, registration($a, $rpId, $cred, 0x44), $ch, $rpId, [$origin]), 'presence'));
$check('registration: without key (AT flag missing)', $throws(fn () => WebAuthn::verifyRegistration($cdr, registration($a, $rpId, $cred, 0x05), $ch, $rpId, [$origin]), 'key'));
$check('registration: wrong domain', $throws(fn () => WebAuthn::verifyRegistration($cdr, registration($a, 'x.example.com', $cred), $ch, $rpId, [$origin]), 'domain'));
$weak = ['cose' => [1 => 2, 3 => -8, -1 => 6, -2 => bin(str_repeat('a', 32))]];
$check('registration: unsupported algorithm (EdDSA)', $throws(fn () => WebAuthn::verifyRegistration($cdr, registration($weak, $rpId, $cred), $ch, $rpId, [$origin]), 'key type'));
$short = ['cose' => [1 => 2, 3 => -7, -1 => 1, -2 => bin('short'), -3 => bin('short')]];
$check('registration: invalid EC point', $throws(fn () => WebAuthn::verifyRegistration($cdr, registration($short, $rpId, $cred), $ch, $rpId, [$origin]), 'EC key'));
$check('registration: foreign frames (crossOrigin)', $throws(fn () => WebAuthn::verifyRegistration(clientData('webauthn.create', $ch, $origin, ['crossOrigin' => true]), registration($a, $rpId, $cred), $ch, $rpId, [$origin]), 'frames'));

// ---- CBOR and Base64url
$o = 0;
$check('CBOR: map with negative keys', Cbor::decode(cbor([1 => 2, -1 => 1, -2 => bin('ab')]), $o) === [1 => 2, -1 => 1, -2 => 'ab']);
$o = 0;
$check('CBOR: Listen, Zahlen, Wahrheitswerte', Cbor::decode(cbor([1, -5, 300, 70000, true, false, null, 'text']), $o) === [1, -5, 300, 70000, true, false, null, 'text']);
$check('CBOR: truncated data', $throws(function () { $o = 0; Cbor::decode(substr(cbor(['a' => bin(str_repeat('x', 40))]), 0, 20), $o); }));
$check('CBOR: oversized length', $throws(function () { $o = 0; Cbor::decode("\x5b\xff\xff\xff\xff\xff\xff\xff\xff", $o); }));
$check('CBOR: length beyond the end', $throws(function () { $o = 0; Cbor::decode("\x5a\x7f\xff\xff\xff" . 'abc', $o); }));
$check('CBOR: zu tief verschachtelt', $throws(function () { $o = 0; Cbor::decode(str_repeat("\x81", 40) . "\x01", $o); }));
$check('CBOR: floating point numbers are rejected', $throws(function () { $o = 0; Cbor::decode("\xfb\x3f\xf0\x00\x00\x00\x00\x00\x00", $o); }));
$check('CBOR: keys that are neither number nor text', $throws(function () { $o = 0; Cbor::decode("\xa1\x80\x01", $o); }));
$check('Base64url: strikt', $throws(fn () => WebAuthn::b64uDecode('ab+/')) && $throws(fn () => WebAuthn::b64uDecode('')) && WebAuthn::b64uDecode(WebAuthn::b64uEncode("\xff\xfe\x00")) === "\xff\xfe\x00");

exit($fail);
