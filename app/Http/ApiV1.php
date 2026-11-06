<?php
declare(strict_types=1);

namespace WebManager\Http;

/**
 * The stable public API below /api/v1. It is an allowlist: only the routes listed here exist, each one is mapped to an
 * internal route, so roles and 2FA rules apply exactly as for the dashboard itself.
 * Everything else under /api/v1 answers 404, even if an internal /api/... route of the same shape exists.
 */
final class ApiV1
{
    public const PREFIX = '/api/v1/';

    /** [method, v1 pattern, internal path template or null for a route that is served directly] */
    private const MAP = [
        ['GET', '#^/api/v1/me$#', null],
        ['GET', '#^/api/v1/metrics$#', null],
        ['GET', '#^/api/v1/sites$#', '/api/overview'],
        ['GET', '#^/api/v1/sites/(\d+)$#', '/api/sites/$1'],
        ['GET', '#^/api/v1/sites/(\d+)/(status|logs|metrics|jobs|uptime|resources)$#', '/api/sites/$1/$2'],
        ['POST', '#^/api/v1/sites/(\d+)/action$#', '/api/sites/$1/action'],
        ['GET', '#^/api/v1/jobs$#', '/api/jobs'],
        ['GET', '#^/api/v1/jobs/(\d+)$#', '/api/jobs/$1'],
        ['GET', '#^/api/v1/jobs/(\d+)/logs$#', '/api/jobs/$1/logs'],
        ['POST', '#^/api/v1/jobs/(\d+)/cancel$#', '/api/jobs/$1/cancel'],
    ];

    public static function isV1(string $path): bool
    {
        return str_starts_with($path, self::PREFIX);
    }

    /** Internal path for a v1 request, the unchanged path for directly served routes, null when v1 has no such route. */
    public static function resolve(string $method, string $path): ?string
    {
        $method = $method === 'HEAD' ? 'GET' : $method;
        foreach (self::MAP as [$m, $re, $internal]) {
            if ($m === $method && preg_match($re, $path, $mm)) {
                return $internal === null ? $path : (string) preg_replace_callback('/\$(\d)/', static fn (array $x): string => $mm[(int) $x[1]], $internal);
            }
        }
        return null;
    }

    /** @return list<array{string,string}> method and v1 pattern of every route, used by the contract test against the OpenAPI file */
    public static function routes(): array
    {
        return array_map(static fn (array $r): array => [$r[0], $r[1]], self::MAP);
    }
}
