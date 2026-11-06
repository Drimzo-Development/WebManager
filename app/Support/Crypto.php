<?php
declare(strict_types=1);

namespace WebManager\Support;

/**
 * AES-256-GCM, format base64( iv[12] | tag[16] | ciphertext ). Compatible with workers/src/crypto.js.
 */
final class Crypto
{
    private static function key(): string
    {
        $hex = Env::require('APP_KEY');
        if (!preg_match('/^[0-9a-f]{64}$/i', $hex)) {
            throw new \RuntimeException('APP_KEY must be 64 hex characters');
        }
        return (string) hex2bin($hex);
    }

    public static function encrypt(string $plain): string
    {
        $iv = random_bytes(12);
        $tag = '';
        $ct = openssl_encrypt($plain, 'aes-256-gcm', self::key(), OPENSSL_RAW_DATA, $iv, $tag, '', 16);
        if ($ct === false) {
            throw new \RuntimeException('Encryption failed');
        }
        return base64_encode($iv . $tag . $ct);
    }

    public static function decrypt(string $b64): string
    {
        $raw = base64_decode($b64, true);
        if ($raw === false || strlen($raw) < 29) {
            throw new \RuntimeException('Invalid ciphertext');
        }
        $plain = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', self::key(), OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16));
        if ($plain === false) {
            throw new \RuntimeException('Decryption failed');
        }
        return $plain;
    }
}
