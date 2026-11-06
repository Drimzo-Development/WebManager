<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\JobQueue;
use WebManager\Services\SiteService;
use WebManager\Support\Audit;
use WebManager\Support\Db;
use WebManager\Support\Env;

/** Weekly statistics report per website, mailed to its own recipient list (operators). The worker sends the mails. */
final class ReportApi
{
    private const MAX_RECIPIENTS = 10;

    private static function siteId(array $p): int
    {
        $id = filter_var($p['id'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 40000]]);
        if ($id === false) {
            throw new HttpException(404, 'Website not found');
        }
        SiteService::row((int) $id);
        return (int) $id;
    }

    public static function get(Request $req, array $p): never
    {
        $id = self::siteId($p);
        $r = Db::one('SELECT enabled, recipients, weekday, hour, last_sent_at FROM site_reports WHERE site_id = ?', [$id]);
        Response::json([
            'enabled' => $r ? (bool) $r['enabled'] : false,
            'recipients' => $r ? (string) $r['recipients'] : '',
            'weekday' => $r ? (int) $r['weekday'] : 1,
            'hour' => $r ? (int) $r['hour'] : 8,
            'last_sent_at' => $r && $r['last_sent_at'] !== null ? str_replace(' ', 'T', (string) $r['last_sent_at']) . 'Z' : null,
            'tz' => Env::get('TZ', 'UTC'),
            'smtp_ready' => (string) Db::val("SELECT v FROM settings WHERE k = 'smtp_host'") !== '',
        ]);
    }

    public static function put(Request $req, array $p): never
    {
        $id = self::siteId($p);
        $in = $req->json();
        $list = preg_split('/[\s,;]+/', trim((string) ($in['recipients'] ?? '')), -1, PREG_SPLIT_NO_EMPTY) ?: [];
        $list = array_values(array_unique(array_map('mb_strtolower', $list)));
        foreach ($list as $addr) {
            if (!filter_var($addr, FILTER_VALIDATE_EMAIL)) {
                throw new HttpException(422, 'Invalid recipient address: ' . mb_substr($addr, 0, 80));
            }
        }
        if (count($list) > self::MAX_RECIPIENTS) {
            throw new HttpException(422, 'At most ' . self::MAX_RECIPIENTS . ' recipients.');
        }
        $weekday = filter_var($in['weekday'] ?? 1, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 6]]);
        $hour = filter_var($in['hour'] ?? 8, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 23]]);
        if ($weekday === false || $hour === false) {
            throw new HttpException(422, 'Invalid weekday or time.');
        }
        $enabled = !empty($in['enabled']);
        if ($enabled && !$list) {
            throw new HttpException(422, 'To enable it, at least one recipient is required.');
        }
        $recipients = implode("\n", $list);
        // last_sent_at stays untouched, so editing the settings never triggers a second mail in the same week
        Db::exec(
            'INSERT INTO site_reports (site_id, enabled, recipients, weekday, hour) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), recipients = VALUES(recipients), weekday = VALUES(weekday), hour = VALUES(hour)',
            [$id, $enabled ? 1 : 0, $recipients, $weekday, $hour]
        );
        Audit::log('report.update', "site-$id", ['enabled' => $enabled, 'recipients' => count($list)]);
        Response::json(['ok' => true]);
    }

    /** Sends the report now (to the saved recipients), regardless of the schedule. */
    public static function send(Request $req, array $p): never
    {
        $id = self::siteId($p);
        $r = Db::one('SELECT recipients FROM site_reports WHERE site_id = ?', [$id]);
        if (!$r || trim((string) $r['recipients']) === '') {
            throw new HttpException(422, 'Please save recipients first.');
        }
        if ((string) Db::val("SELECT v FROM settings WHERE k = 'smtp_host'") === '') {
            throw new HttpException(422, 'No SMTP server is configured (System → Email & notifications).');
        }
        $job = JobQueue::enqueue('site.report', $id, 'Send statistics report – “' . SiteService::siteName($id) . '”', ['manual' => true]);
        Audit::log('report.send', "site-$id");
        Response::json(['job' => $job]);
    }
}
