<?php
declare(strict_types=1);

namespace WebManager\Support;

/**
 * Minimal WebAuthn relying party for passkeys as second factor: registration with "none" attestation and assertion verification
 * for ES256 (-7) and RS256 (-257). No attestation trust chains are evaluated (the passkey only has to prove possession of its key
 * for a user who already passed the password check). All errors are RuntimeExceptions with readable German messages.
 */
final class WebAuthn
{
    public const ALG_ES256 = -7;
    public const ALG_RS256 = -257;

    public static function b64uEncode(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    public static function b64uDecode(string $s): string
    {
        if ($s === '' || !preg_match('/^[A-Za-z0-9_-]+$/', $s)) {
            throw new \RuntimeException('Invalid Base64 data.');
        }
        $bin = base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
        if ($bin === false) {
            throw new \RuntimeException('Invalid Base64 data.');
        }
        return $bin;
    }

    /** @return array{id:string, cose:string, alg:int, signCount:int, uv:bool} */
    public static function verifyRegistration(string $clientDataJson, string $attestationObject, string $challenge, string $rpId, array $origins): array
    {
        self::checkClientData($clientDataJson, 'webauthn.create', $challenge, $origins);
        $o = 0;
        $att = Cbor::decode($attestationObject, $o);
        if (!is_array($att) || ($att['fmt'] ?? null) !== 'none' || !is_string($att['authData'] ?? null)) {
            throw new \RuntimeException('Only registration without manufacturer attestation is supported.');
        }
        $ad = self::authData($att['authData'], true);
        self::checkRp($ad, $rpId);
        if (!($ad['flags'] & 0x01)) {
            throw new \RuntimeException('User presence was not confirmed.');
        }
        $key = $ad['key'];
        $alg = $key[3] ?? null;
        if ($alg !== self::ALG_ES256 && $alg !== self::ALG_RS256) {
            throw new \RuntimeException('This key type is not supported.');
        }
        self::pem($key); // validates the key
        return ['id' => $ad['credId'], 'cose' => $ad['coseRaw'], 'alg' => (int) $alg, 'signCount' => $ad['signCount'], 'uv' => (bool) ($ad['flags'] & 0x04)];
    }

    /** @return array{signCount:int, uv:bool} */
    public static function verifyAssertion(string $clientDataJson, string $authenticatorData, string $signature, string $challenge, string $rpId, array $origins, string $coseRaw, int $storedCount, bool $requireUv = false): array
    {
        self::checkClientData($clientDataJson, 'webauthn.get', $challenge, $origins);
        $ad = self::authData($authenticatorData, false);
        self::checkRp($ad, $rpId);
        if (!($ad['flags'] & 0x01)) {
            throw new \RuntimeException('User presence was not confirmed.');
        }
        if ($requireUv && !($ad['flags'] & 0x04)) {
            throw new \RuntimeException('Signing in without a password requires fingerprint, face recognition or PIN of the device.');
        }
        $o = 0;
        $key = Cbor::decode($coseRaw, $o);
        if (!is_array($key)) {
            throw new \RuntimeException('Stored key is invalid.');
        }
        $ok = openssl_verify($authenticatorData . hash('sha256', $clientDataJson, true), $signature, self::pem($key), OPENSSL_ALGO_SHA256);
        if ($ok !== 1) {
            throw new \RuntimeException('The signature is invalid.');
        }
        $count = $ad['signCount'];
        if (($count !== 0 || $storedCount !== 0) && $count <= $storedCount) {
            throw new \RuntimeException('The signature counter did not increase (the passkey may have been copied).');
        }
        return ['signCount' => $count, 'uv' => (bool) ($ad['flags'] & 0x04)];
    }

    /** @param list<string> $origins */
    private static function checkClientData(string $json, string $type, string $challenge, array $origins): void
    {
        $cd = json_decode($json, true);
        if (!is_array($cd) || ($cd['type'] ?? null) !== $type) {
            throw new \RuntimeException('Invalid client data.');
        }
        if (!is_string($cd['challenge'] ?? null) || !hash_equals(self::b64uEncode($challenge), $cd['challenge'])) {
            throw new \RuntimeException('The request has expired or does not belong to this sign-in.');
        }
        if (!is_string($cd['origin'] ?? null) || !in_array($cd['origin'], $origins, true)) {
            throw new \RuntimeException('The origin of the request does not match.');
        }
        if (($cd['crossOrigin'] ?? false) === true) {
            throw new \RuntimeException('Requests from foreign frames are not accepted.');
        }
    }

    /** @param array<string,mixed> $ad */
    private static function checkRp(array $ad, string $rpId): void
    {
        if (!hash_equals(hash('sha256', $rpId, true), $ad['rpIdHash'])) {
            throw new \RuntimeException('The passkey belongs to another domain.');
        }
    }

    /** @return array<string,mixed> */
    private static function authData(string $ad, bool $attested): array
    {
        if (strlen($ad) < 37) {
            throw new \RuntimeException('Invalid authenticator data.');
        }
        $flags = ord($ad[32]);
        $out = ['rpIdHash' => substr($ad, 0, 32), 'flags' => $flags, 'signCount' => (int) unpack('N', substr($ad, 33, 4))[1]];
        if ($attested) {
            if (!($flags & 0x40) || strlen($ad) < 55) {
                throw new \RuntimeException('The registration contains no key.');
            }
            $len = (int) unpack('n', substr($ad, 53, 2))[1];
            if ($len < 1 || $len > 1023 || strlen($ad) < 55 + $len) {
                throw new \RuntimeException('Invalid credential ID.');
            }
            $out['credId'] = substr($ad, 55, $len);
            $start = 55 + $len;
            $o = $start;
            $key = Cbor::decode($ad, $o);
            if (!is_array($key)) {
                throw new \RuntimeException('Invalid public key.');
            }
            $out['key'] = $key;
            $out['coseRaw'] = substr($ad, $start, $o - $start);
        }
        return $out;
    }

    /** PEM public key from a COSE key (EC2 P-256 / RSA). @param array<int|string,mixed> $k */
    public static function pem(array $k): string
    {
        $alg = $k[3] ?? null;
        if ($alg === self::ALG_ES256) {
            $x = $k[-2] ?? null;
            $y = $k[-3] ?? null;
            if (($k[1] ?? null) !== 2 || ($k[-1] ?? null) !== 1 || !is_string($x) || !is_string($y) || strlen($x) !== 32 || strlen($y) !== 32) {
                throw new \RuntimeException('Invalid EC key.');
            }
            $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . "\x04" . $x . $y;
        } elseif ($alg === self::ALG_RS256) {
            $n = $k[-1] ?? null;
            $e = $k[-2] ?? null;
            if (($k[1] ?? null) !== 3 || !is_string($n) || !is_string($e) || strlen($n) < 128 || strlen($n) > 1024 || strlen($e) < 1 || strlen($e) > 8) {
                throw new \RuntimeException('Invalid RSA key.');
            }
            $rsa = self::der(0x30, self::derInt($n) . self::derInt($e));
            $algId = self::der(0x30, hex2bin('06092a864886f70d0101010500'));
            $der = self::der(0x30, $algId . self::der(0x03, "\x00" . $rsa));
        } else {
            throw new \RuntimeException('This key type is not supported.');
        }
        return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
    }

    private static function der(int $tag, string $content): string
    {
        $len = strlen($content);
        $l = $len < 128 ? chr($len) : ($len < 256 ? "\x81" . chr($len) : "\x82" . chr($len >> 8) . chr($len & 0xff));
        return chr($tag) . $l . $content;
    }

    private static function derInt(string $bin): string
    {
        $bin = ltrim($bin, "\x00");
        if ($bin === '' || ord($bin[0]) >= 0x80) {
            $bin = "\x00" . $bin;
        }
        return self::der(0x02, $bin);
    }
}
