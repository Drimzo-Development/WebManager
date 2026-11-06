<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\JobQueue;
use WebManager\Support\Audit;
use WebManager\Support\Crypto;
use WebManager\Support\Db;

/** Notification channels (email/SMTP, webhook, ntfy, Telegram) and rules (administrators only). The worker sends the messages. */
final class NotificationsApi
{
    private const KEYS = [
        'smtp_host', 'smtp_port', 'smtp_security', 'smtp_user', 'smtp_pass_enc', 'smtp_from',
        'notify_enabled', 'notify_to', 'notify_site_down', 'notify_cert', 'notify_cert_days',
        'notify_jobs', 'notify_backup', 'notify_disk', 'notify_disk_percent', 'notify_update', 'notify_login',
        'notify_bans', 'notify_bans_threshold', 'notify_resources', 'notify_mem_percent', 'notify_site_disk_gb',
        'notify_webhook_enc', 'notify_webhook_secret_enc', 'notify_ntfy_enc', 'notify_ntfy_token_enc', 'notify_tg_token_enc', 'notify_tg_chat',
    ];

    private const TG_TOKEN = '/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/';
    private const TG_CHAT = '/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,63})$/';

    /** @return array<string,string> */
    private static function load(): array
    {
        $marks = implode(',', array_fill(0, count(self::KEYS), '?'));
        return array_column(Db::all("SELECT k, v FROM settings WHERE k IN ($marks)", self::KEYS), 'v', 'k');
    }

    private static function save(string $k, string $v): void
    {
        Db::exec('REPLACE INTO settings (k, v) VALUES (?, ?)', [$k, $v]);
    }

    /** Host of a stored (encrypted) address for display; the address itself can contain a secret and is never sent back. */
    private static function hostOf(string $enc): string
    {
        if ($enc === '') {
            return '';
        }
        try {
            return (string) parse_url(Crypto::decrypt($enc), PHP_URL_HOST);
        } catch (\Throwable) {
            return '';
        }
    }

    /** Addresses inside the server (this host, link-local incl. the cloud metadata address) are never a notification target. */
    private static function blockedIp(string $ip): bool
    {
        if (!filter_var($ip, FILTER_VALIDATE_IP)) {
            return true;
        }
        $ip = strtolower($ip);
        if (preg_match('/^::ffff:(\d+\.\d+\.\d+\.\d+)$/', $ip, $m)) {
            $ip = $m[1];
        }
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            [$a, $b] = array_map('intval', explode('.', $ip));
            // 172.16/12: Docker networks of this stack, 100.64/10: carrier-grade NAT (10/8 and 192.168/16 stay allowed for LAN targets)
            return $a === 0 || $a === 127 || ($a === 169 && $b === 254) || ($a === 172 && $b >= 16 && $b <= 31) || ($a === 100 && $b >= 64 && $b <= 127);
        }
        return $ip === '::' || $ip === '::1' || (bool) preg_match('/^(fe[89ab]|f[cd])/', $ip);
    }

    /** https address with a full domain name and without credentials (same rules as the worker). */
    private static function cleanUrl(string $raw, string $what): string
    {
        $raw = trim($raw);
        $u = parse_url($raw);
        if ($raw === '' || $u === false || ($u['scheme'] ?? '') !== 'https' || empty($u['host'])) {
            throw new HttpException(422, "$what: please enter an address starting with https://");
        }
        if (isset($u['user']) || isset($u['pass'])) {
            throw new HttpException(422, "$what: the address must not contain credentials.");
        }
        $host = trim((string) $u['host'], '[]');
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            if (self::blockedIp($host)) {
                throw new HttpException(422, "$what: this address is not allowed.");
            }
        } elseif (!str_contains($host, '.') || preg_match('/\.(internal|local|localhost)$/i', $host)) {
            throw new HttpException(422, "$what: please use a full domain name.");
        }
        if (strlen($raw) > 500 || preg_match('/[\x00-\x20]/', $raw)) {
            throw new HttpException(422, "$what: invalid address.");
        }
        return $raw;
    }

    private static function cleanSecret(mixed $v, string $what): string
    {
        $v = trim((string) $v);
        if (strlen($v) > 300 || preg_match('/[\x00-\x1f]/', $v)) {
            throw new HttpException(422, "$what is invalid.");
        }
        return $v;
    }

    public static function get(Request $req): never
    {
        $m = self::load();
        Response::json([
            'smtp_host' => $m['smtp_host'] ?? '',
            'smtp_port' => (int) ($m['smtp_port'] ?? 587),
            'smtp_security' => $m['smtp_security'] ?? 'starttls',
            'smtp_user' => $m['smtp_user'] ?? '',
            'has_password' => ($m['smtp_pass_enc'] ?? '') !== '',
            'smtp_from' => $m['smtp_from'] ?? '',
            'enabled' => ($m['notify_enabled'] ?? '0') === '1',
            'recipients' => $m['notify_to'] ?? '',
            'site_down' => ($m['notify_site_down'] ?? '1') === '1',
            'cert' => ($m['notify_cert'] ?? '1') === '1',
            'cert_days' => (int) ($m['notify_cert_days'] ?? 14),
            'jobs' => ($m['notify_jobs'] ?? '1') === '1',
            'backup' => ($m['notify_backup'] ?? '1') === '1',
            'disk' => ($m['notify_disk'] ?? '1') === '1',
            'disk_percent' => (int) ($m['notify_disk_percent'] ?? 90),
            'update_notice' => ($m['notify_update'] ?? '1') === '1',
            'login_alert' => ($m['notify_login'] ?? '1') === '1',
            'bans' => ($m['notify_bans'] ?? '1') === '1',
            'bans_threshold' => (int) ($m['notify_bans_threshold'] ?? 10),
            'resources' => ($m['notify_resources'] ?? '1') === '1',
            'mem_percent' => (int) ($m['notify_mem_percent'] ?? 90),
            'site_disk_gb' => (float) ($m['notify_site_disk_gb'] ?? 0),
            'webhook_host' => self::hostOf($m['notify_webhook_enc'] ?? ''),
            'webhook_secret_set' => ($m['notify_webhook_secret_enc'] ?? '') !== '',
            'ntfy_host' => self::hostOf($m['notify_ntfy_enc'] ?? ''),
            'ntfy_token_set' => ($m['notify_ntfy_token_enc'] ?? '') !== '',
            'telegram_set' => ($m['notify_tg_token_enc'] ?? '') !== '',
            'telegram_chat' => $m['notify_tg_chat'] ?? '',
        ]);
    }

    public static function put(Request $req): never
    {
        $in = $req->json();
        $host = trim((string) ($in['smtp_host'] ?? ''));
        if ($host !== '' && !preg_match('/^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/', $host)) {
            throw new HttpException(422, 'Invalid SMTP server.');
        }
        $port = filter_var($in['smtp_port'] ?? 587, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 65535]]);
        if ($port === false) {
            throw new HttpException(422, 'SMTP port: 1–65535.');
        }
        $security = (string) ($in['smtp_security'] ?? 'starttls');
        if (!in_array($security, ['starttls', 'tls', 'none'], true)) {
            throw new HttpException(422, 'Unknown encryption.');
        }
        $user = trim((string) ($in['smtp_user'] ?? ''));
        if (strlen($user) > 190 || preg_match('/[\x00-\x1f]/', $user)) {
            throw new HttpException(422, 'Invalid SMTP username.');
        }
        $from = trim((string) ($in['smtp_from'] ?? ''));
        if ($from !== '' && !filter_var($from, FILTER_VALIDATE_EMAIL)) {
            throw new HttpException(422, 'Please enter a valid sender address.');
        }
        $list = preg_split('/[\s,;]+/', trim((string) ($in['recipients'] ?? '')), -1, PREG_SPLIT_NO_EMPTY) ?: [];
        foreach ($list as $addr) {
            if (!filter_var($addr, FILTER_VALIDATE_EMAIL)) {
                throw new HttpException(422, 'Invalid recipient address: ' . mb_substr($addr, 0, 80));
            }
        }
        if (count($list) > 20) {
            throw new HttpException(422, 'At most 20 recipients.');
        }
        $days = filter_var($in['cert_days'] ?? 14, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 60]]);
        if ($days === false) {
            throw new HttpException(422, 'Certificate warning: 1–60 days in advance.');
        }
        $diskPercent = filter_var($in['disk_percent'] ?? 90, FILTER_VALIDATE_INT, ['options' => ['min_range' => 50, 'max_range' => 99]]);
        if ($diskPercent === false) {
            throw new HttpException(422, 'Storage warning: 50–99 % usage.');
        }
        $bansMin = filter_var($in['bans_threshold'] ?? 10, FILTER_VALIDATE_INT, ['options' => ['min_range' => 2, 'max_range' => 1000]]);
        if ($bansMin === false) {
            throw new HttpException(422, 'Ban wave: 2–1000 addresses.');
        }

        $memPercent = filter_var($in['mem_percent'] ?? 90, FILTER_VALIDATE_INT, ['options' => ['min_range' => 50, 'max_range' => 99]]);
        if ($memPercent === false) {
            throw new HttpException(422, 'Memory warning: 50–99 % of the limit.');
        }
        $siteDiskGb = filter_var($in['site_disk_gb'] ?? 0, FILTER_VALIDATE_FLOAT, ['options' => ['min_range' => 0, 'max_range' => 100000]]);
        if ($siteDiskGb === false) {
            throw new HttpException(422, 'Website size warning: 0 (off) to 100000 GB.');
        }

        // webhook / ntfy / Telegram: an empty field keeps the stored value, "clear_*" removes it
        $cur = self::load();
        $webhook = trim((string) ($in['webhook_url'] ?? ''));
        if ($webhook !== '') {
            $webhook = self::cleanUrl($webhook, 'Webhook');
        }
        $ntfy = trim((string) ($in['ntfy_url'] ?? ''));
        if ($ntfy !== '') {
            $ntfy = self::cleanUrl($ntfy, 'ntfy');
            $topic = trim((string) parse_url($ntfy, PHP_URL_PATH), '/');
            if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $topic)) {
                throw new HttpException(422, 'ntfy: the address must end with the topic, e.g. https://ntfy.sh/my-topic');
            }
        }
        $webhookSecret = self::cleanSecret($in['webhook_secret'] ?? '', 'Webhook secret');
        $ntfyToken = self::cleanSecret($in['ntfy_token'] ?? '', 'ntfy token');
        $tgToken = trim((string) ($in['telegram_token'] ?? ''));
        if ($tgToken !== '' && !preg_match(self::TG_TOKEN, $tgToken)) {
            throw new HttpException(422, 'Telegram: invalid bot token.');
        }
        $tgChat = trim((string) ($in['telegram_chat'] ?? ''));
        if ($tgChat !== '' && !preg_match(self::TG_CHAT, $tgChat)) {
            throw new HttpException(422, 'Telegram: the chat is a number (e.g. -1001234567890) or @channelname.');
        }
        $clearWebhook = !empty($in['clear_webhook']);
        $clearNtfy = !empty($in['clear_ntfy']);
        $clearTelegram = !empty($in['clear_telegram']);
        $hasWebhook = !$clearWebhook && ($webhook !== '' || ($cur['notify_webhook_enc'] ?? '') !== '');
        $hasNtfy = !$clearNtfy && ($ntfy !== '' || ($cur['notify_ntfy_enc'] ?? '') !== '');
        $hasTelegram = !$clearTelegram && ($tgToken !== '' || ($cur['notify_tg_token_enc'] ?? '') !== '')
            && ($tgChat !== '' || ($cur['notify_tg_chat'] ?? '') !== '');
        if (!$clearTelegram && ($tgToken !== '' || ($cur['notify_tg_token_enc'] ?? '') !== '') && !$hasTelegram) {
            throw new HttpException(422, 'Telegram: bot token and chat are both required.');
        }

        $enabled = !empty($in['enabled']);
        $hasEmail = $host !== '' && $from !== '' && $list;
        if ($enabled && !$hasEmail && !$hasWebhook && !$hasNtfy && !$hasTelegram) {
            throw new HttpException(422, 'To enable it, set up at least one channel: email (SMTP server, sender and recipient), webhook, ntfy or Telegram.');
        }

        self::save('smtp_host', $host);
        self::save('smtp_port', (string) $port);
        self::save('smtp_security', $security);
        self::save('smtp_user', $user);
        self::save('smtp_from', $from);
        $password = (string) ($in['smtp_password'] ?? '');
        if (!empty($in['clear_password'])) {
            self::save('smtp_pass_enc', '');
        } elseif ($password !== '') {
            self::save('smtp_pass_enc', Crypto::encrypt($password));
        }
        self::save('notify_to', implode("\n", $list));
        self::save('notify_enabled', $enabled ? '1' : '0');
        self::save('notify_site_down', !empty($in['site_down']) ? '1' : '0');
        self::save('notify_cert', !empty($in['cert']) ? '1' : '0');
        self::save('notify_cert_days', (string) $days);
        self::save('notify_jobs', !empty($in['jobs']) ? '1' : '0');
        self::save('notify_backup', !empty($in['backup']) ? '1' : '0');
        self::save('notify_disk', !empty($in['disk']) ? '1' : '0');
        self::save('notify_disk_percent', (string) $diskPercent);
        self::save('notify_update', !array_key_exists('update_notice', $in) || !empty($in['update_notice']) ? '1' : '0');
        self::save('notify_login', !array_key_exists('login_alert', $in) || !empty($in['login_alert']) ? '1' : '0');
        self::save('notify_bans', !array_key_exists('bans', $in) || !empty($in['bans']) ? '1' : '0');
        self::save('notify_bans_threshold', (string) $bansMin);
        self::save('notify_resources', !array_key_exists('resources', $in) || !empty($in['resources']) ? '1' : '0');
        self::save('notify_mem_percent', (string) $memPercent);
        self::save('notify_site_disk_gb', (string) $siteDiskGb);
        if ($clearWebhook) {
            self::save('notify_webhook_enc', '');
            self::save('notify_webhook_secret_enc', '');
        } else {
            if ($webhook !== '') {
                self::save('notify_webhook_enc', Crypto::encrypt($webhook));
            }
            if ($webhookSecret !== '') {
                self::save('notify_webhook_secret_enc', Crypto::encrypt($webhookSecret));
            }
        }
        if ($clearNtfy) {
            self::save('notify_ntfy_enc', '');
            self::save('notify_ntfy_token_enc', '');
        } else {
            if ($ntfy !== '') {
                self::save('notify_ntfy_enc', Crypto::encrypt($ntfy));
            }
            if ($ntfyToken !== '') {
                self::save('notify_ntfy_token_enc', Crypto::encrypt($ntfyToken));
            }
        }
        if ($clearTelegram) {
            self::save('notify_tg_token_enc', '');
            self::save('notify_tg_chat', '');
        } else {
            if ($tgToken !== '') {
                self::save('notify_tg_token_enc', Crypto::encrypt($tgToken));
            }
            if ($tgChat !== '') {
                self::save('notify_tg_chat', $tgChat);
            }
        }
        Audit::log('settings.notifications', 'channels', [
            'enabled' => $enabled, 'email' => (bool) $hasEmail, 'webhook' => $hasWebhook, 'ntfy' => $hasNtfy, 'telegram' => $hasTelegram,
        ]);
        Response::json(['ok' => true]);
    }

    public static function test(Request $req): never
    {
        $job = JobQueue::enqueue('notify.test', null, 'Send test notification');
        Audit::log('settings.notifications_test', 'channels');
        Response::json(['job' => $job]);
    }
}
