<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\JobQueue;
use WebManager\Services\SiteService;
use WebManager\Support\Audit;
use WebManager\Support\Crypto;
use WebManager\Support\Db;

/**
 * Connection to a DNS provider (Cloudflare, Hetzner): needed for wildcard certificates (validation through DNS) and for setting the
 * A/AAAA records of a website. The token is stored encrypted, never sent back, and handed to the agent by the worker.
 */
final class DnsApi
{
    public const PROVIDERS = ['cloudflare' => 'Cloudflare', 'hetzner' => 'Hetzner'];

    private static function setting(string $k): string
    {
        return (string) Db::val('SELECT v FROM settings WHERE k = ?', [$k]);
    }

    public static function configured(): bool
    {
        return isset(self::PROVIDERS[self::setting('dns_provider')]) && self::setting('dns_token_enc') !== '';
    }

    public static function show(Request $req): never
    {
        $p = self::setting('dns_provider');
        Response::json([
            'configured' => self::configured(),
            'provider' => self::configured() ? $p : null,
            'providers' => self::PROVIDERS,
            'wait' => (int) (self::setting('dns_wait') ?: 30),
        ]);
    }

    public static function save(Request $req): never
    {
        $in = $req->json();
        $provider = (string) ($in['provider'] ?? '');
        if (!isset(self::PROVIDERS[$provider])) {
            throw new HttpException(422, 'Please choose a DNS provider.');
        }
        $wait = (int) ($in['wait'] ?? (self::setting('dns_wait') ?: 30));
        if ($wait < 0 || $wait > 300) {
            throw new HttpException(422, 'Wait time: 0 to 300 seconds.');
        }
        $token = trim((string) ($in['token'] ?? ''));
        if ($token === '') {
            // keeping the saved token is only possible for the same provider
            if (!self::configured() || self::setting('dns_provider') !== $provider) {
                throw new HttpException(422, 'Please enter the API token.');
            }
        } elseif (!preg_match('/^[\x21-\x7e]{8,500}$/', $token)) {
            throw new HttpException(422, 'The API token looks invalid (8 to 500 visible characters, no spaces).');
        } else {
            Db::exec("REPLACE INTO settings (k, v) VALUES ('dns_token_enc', ?)", [Crypto::encrypt($token)]);
        }
        Db::exec("REPLACE INTO settings (k, v) VALUES ('dns_provider', ?)", [$provider]);
        Db::exec("REPLACE INTO settings (k, v) VALUES ('dns_wait', ?)", [(string) $wait]);
        Audit::log('dns.save', $provider, ['token_changed' => $token !== '']);
        $job = JobQueue::enqueue('dns.apply', null, 'Connect DNS provider ' . self::PROVIDERS[$provider]);
        Response::json(['job' => $job]);
    }

    public static function remove(Request $req): never
    {
        Db::exec("DELETE FROM settings WHERE k IN ('dns_provider', 'dns_token_enc', 'dns_wait')");
        Audit::log('dns.remove');
        $job = JobQueue::enqueue('dns.apply', null, 'Remove DNS provider');
        Response::json(['job' => $job]);
    }

    public static function test(Request $req): never
    {
        if (!self::configured()) {
            throw new HttpException(422, 'No DNS provider is set up.');
        }
        Response::json(['job' => JobQueue::enqueue('dns.test', null, 'Test DNS provider')]);
    }

    /** Sets the A/AAAA records of all domains of a website to this server (operators). */
    public static function siteRecords(Request $req, array $p): never
    {
        $id = filter_var($p['id'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 40000]]);
        if ($id === false) {
            throw new HttpException(404, 'Website not found');
        }
        $site = SiteService::row((int) $id);
        if (!self::configured()) {
            throw new HttpException(422, 'No DNS provider is set up. An administrator can do this under System → DNS provider.');
        }
        if (!SiteService::domains((int) $id)) {
            throw new HttpException(422, 'No domains are assigned to the website yet.');
        }
        Audit::log('site.dns_records', SiteService::siteName((int) $id));
        Response::json(['job' => JobQueue::enqueue('site.dns_records', (int) $id, 'Set DNS records for “' . $site['name'] . '”')]);
    }
}
