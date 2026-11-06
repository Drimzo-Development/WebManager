<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\Agent;
use WebManager\Services\JobQueue;
use WebManager\Support\Audit;
use WebManager\Support\Db;

/** Server-wide flood protection: automatic and manual IP bans (administrators only). The agent enforces them in the proxy. */
final class ProtectionApi
{
    private const DEFAULTS = [
        'autoBan' => ['enabled' => false, 'maxRequests' => 600, 'maxErrors' => 150, 'windowSec' => 60, 'banMinutes' => 60],
        'whitelist' => [],
        'manual' => [],
    ];

    /** @return array<string,mixed> */
    private static function config(): array
    {
        $raw = Db::val("SELECT v FROM settings WHERE k = 'protection_config'");
        $conf = is_string($raw) ? json_decode($raw, true) : null;
        return is_array($conf) ? array_replace_recursive(self::DEFAULTS, $conf) : self::DEFAULTS;
    }

    /** @return list<string> */
    private static function nets(mixed $v, string $label): array
    {
        $parts = is_array($v) ? $v : (preg_split('/[\s,]+/', (string) $v, -1, PREG_SPLIT_NO_EMPTY) ?: []);
        $out = [];
        foreach ($parts as $item) {
            $item = trim((string) $item);
            $bits = explode('/', $item);
            $kind = filter_var($bits[0], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) ? 4 : (filter_var($bits[0], FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) ? 6 : 0);
            $ok = $kind !== 0 && count($bits) <= 2;
            if ($ok && count($bits) === 2) {
                $ok = preg_match('/^[0-9]{1,3}$/', $bits[1]) === 1 && (int) $bits[1] <= ($kind === 4 ? 32 : 128);
            }
            if (!$ok) {
                throw new HttpException(422, $label . ': invalid IP address or network “' . mb_substr($item, 0, 60) . '”');
            }
            $out[] = $item;
        }
        if (count($out) > 500) {
            throw new HttpException(422, $label . ': at most 500 entries.');
        }
        return array_values(array_unique($out));
    }

    public static function show(Request $req): never
    {
        $bans = [];
        $unreachable = false;
        try {
            $bans = Agent::get('/v1/protection')['bans'] ?? [];
        } catch (HttpException) {
            $unreachable = true;
        }
        Response::json(['config' => self::config(), 'bans' => $bans, 'agent_unreachable' => $unreachable, 'your_ip' => $req->ip()]);
    }

    public static function update(Request $req): never
    {
        $in = $req->json();
        $a = is_array($in['autoBan'] ?? null) ? $in['autoBan'] : [];
        $limits = [
            'maxRequests' => [50, 100000, 'Requests per time window'],
            'maxErrors' => [10, 100000, 'Erroneous requests per time window'],
            'windowSec' => [10, 600, 'Time window (seconds)'],
            'banMinutes' => [1, 10080, 'Ban duration (minutes)'],
        ];
        $auto = ['enabled' => !empty($a['enabled'])];
        foreach ($limits as $key => [$min, $max, $label]) {
            $v = filter_var($a[$key] ?? self::DEFAULTS['autoBan'][$key], FILTER_VALIDATE_INT, ['options' => ['min_range' => $min, 'max_range' => $max]]);
            if ($v === false) {
                throw new HttpException(422, $label . ': ' . $min . '–' . $max . '.');
            }
            $auto[$key] = $v;
        }
        $conf = ['autoBan' => $auto, 'whitelist' => self::nets($in['whitelist'] ?? [], 'Exceptions'), 'manual' => self::nets($in['manual'] ?? [], 'Permanent bans')];
        $yours = $req->ip();
        foreach ($conf['manual'] as $n) {
            if ($n === $yours) {
                throw new HttpException(422, 'This is your own address (' . $yours . ') – you would lock yourself out.');
            }
        }
        Db::exec("REPLACE INTO settings (k, v) VALUES ('protection_config', ?)", [json_encode($conf, JSON_UNESCAPED_UNICODE)]);
        Audit::log('settings.protection', 'proxy', ['autoBan' => $auto['enabled'], 'manual' => count($conf['manual']), 'whitelist' => count($conf['whitelist'])]);
        Response::json(['job' => JobQueue::enqueue('protection.apply', null, 'Apply protection settings')]);
    }

    public static function unban(Request $req): never
    {
        $ip = trim((string) ($req->json()['ip'] ?? ''));
        if (!filter_var($ip, FILTER_VALIDATE_IP)) {
            throw new HttpException(422, 'Invalid IP address.');
        }
        Audit::log('settings.unban', $ip);
        Response::json(['job' => JobQueue::enqueue('protection.unban', null, 'Unblock IP ' . $ip, ['ip' => $ip])]);
    }
}
