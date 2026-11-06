<?php
declare(strict_types=1);

namespace WebManager\Http;

/** Minimum role per request. First matching rule wins; anything not listed needs an operator. */
final class Permissions
{
    private const RULES = [
        // [method or '*', path regex, minimum role]
        ['GET', '#^/api/dns$#', 'operator'], // whether a DNS provider is set up (no secret)
        ['*', '#^/api/(users|audit|settings|branding|protection|update|backup|storage|dns)(/|$)#', 'admin'],
        ['POST', '#^/api/system/#', 'admin'],
        // interactive shell in a website container: administrators only
        ['*', '#^/(console/\d+|api/sites/\d+/console|api/console/(auth|confirm|ticket/[0-9a-f]{32}|sessions/[0-9a-f]{16}/kill))$#', 'admin'],
        ['*', '#^/api/account(/|$)#', 'viewer'],
        ['GET', '#^/api/v1/(me|metrics)$#', 'viewer'],
        ['GET', '#^/api/sites/\d+/(env|files|logs|gate|webserver|cert|scripts|maintenance|rules|security|metrics|report|database|cron)(/|$)#', 'operator'],
        ['GET', '#^/api/system$#', 'operator'],
        ['GET', '#^/(|app)$#', 'viewer'],
        ['GET', '#^/api/(overview|jobs|jobs/\d+|jobs/\d+/logs|sites/\d+|sites/\d+/(status|jobs|uptime|resources))$#', 'viewer'],
        ['*', '#^/logout$#', 'viewer'],
    ];

    public static function required(string $method, string $path): string
    {
        foreach (self::RULES as [$m, $re, $role]) {
            if (($m === '*' || $m === $method) && preg_match($re, $path)) {
                return $role;
            }
        }
        return 'operator';
    }

    public static function check(Request $req): void
    {
        $need = self::required($req->method === 'HEAD' ? 'GET' : $req->method, $req->path);
        if (!Auth::can($need)) {
            throw new HttpException(403, 'You do not have permission for this.');
        }
    }
}
