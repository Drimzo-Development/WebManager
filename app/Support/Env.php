<?php
declare(strict_types=1);

namespace WebManager\Support;

final class Env
{
    public static function get(string $key, ?string $default = null): ?string
    {
        $v = getenv($key);
        if ($v === false || $v === '') {
            return $default;
        }
        return $v;
    }

    public static function require(string $key): string
    {
        $v = self::get($key);
        if ($v === null) {
            throw new \RuntimeException("Missing required environment variable $key");
        }
        return $v;
    }
}
