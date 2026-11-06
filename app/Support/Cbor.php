<?php
declare(strict_types=1);

namespace WebManager\Support;

/** Minimal CBOR decoder for WebAuthn: unsigned/negative integers, byte/text strings, arrays, maps (int/string keys), false/true/null. */
final class Cbor
{
    private const MAX_DEPTH = 12;
    private const MAX_ITEMS = 256;

    public static function decode(string $s, int &$o = 0, int $depth = 0): mixed
    {
        if ($depth > self::MAX_DEPTH || $o >= strlen($s)) {
            throw new \RuntimeException('Invalid CBOR data.');
        }
        $ib = ord($s[$o++]);
        $major = $ib >> 5;
        $ai = $ib & 0x1f;
        if ($major === 7) {
            return match ($ai) {
                20 => false,
                21 => true,
                22, 23 => null,
                default => throw new \RuntimeException('Unsupported CBOR type.'),
            };
        }
        $len = self::length($s, $o, $ai);
        switch ($major) {
            case 0:
                return $len;
            case 1:
                return -1 - $len;
            case 2:
            case 3:
                if ($len > strlen($s) - $o) {
                    throw new \RuntimeException('Invalid CBOR length.');
                }
                $v = substr($s, $o, $len);
                $o += $len;
                return $v;
            case 4:
                if ($len > self::MAX_ITEMS) {
                    throw new \RuntimeException('Too many CBOR elements.');
                }
                $arr = [];
                for ($i = 0; $i < $len; $i++) {
                    $arr[] = self::decode($s, $o, $depth + 1);
                }
                return $arr;
            case 5:
                if ($len > self::MAX_ITEMS) {
                    throw new \RuntimeException('Too many CBOR elements.');
                }
                $map = [];
                for ($i = 0; $i < $len; $i++) {
                    $k = self::decode($s, $o, $depth + 1);
                    if (!is_int($k) && !is_string($k)) {
                        throw new \RuntimeException('Unsupported CBOR key.');
                    }
                    $map[$k] = self::decode($s, $o, $depth + 1);
                }
                return $map;
            default:
                throw new \RuntimeException('Unsupported CBOR type.');
        }
    }

    private static function length(string $s, int &$o, int $ai): int
    {
        if ($ai < 24) {
            return $ai;
        }
        $n = match ($ai) {
            24 => 1,
            25 => 2,
            26 => 4,
            27 => 8,
            default => throw new \RuntimeException('Unsupported CBOR length.'),
        };
        if ($o + $n > strlen($s)) {
            throw new \RuntimeException('Invalid CBOR data.');
        }
        $v = 0;
        for ($i = 0; $i < $n; $i++) {
            $v = ($v << 8) | ord($s[$o + $i]);
        }
        $o += $n;
        if ($v < 0) {
            throw new \RuntimeException('CBOR number too large.');
        }
        return $v;
    }
}
