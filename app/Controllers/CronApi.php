<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\JobQueue;
use WebManager\Services\SiteService;
use WebManager\Support\Audit;
use WebManager\Support\Cron;
use WebManager\Support\Db;
use WebManager\Support\Env;

/** Cron jobs of a website (operators). The worker queues them on schedule; every run is an ordinary job with its own log. */
final class CronApi
{
    private const MAX_PER_SITE = 20;
    private const COLUMNS = 'id, name, schedule, command, timeout_sec, enabled, notify_fail, next_run_at, last_run_at, last_status, last_exit, last_job_id, last_duration_ms';

    private static function siteId(array $p): int
    {
        $id = filter_var($p['id'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 40000]]);
        if ($id === false) {
            throw new HttpException(404, 'Website not found');
        }
        SiteService::row((int) $id);
        return (int) $id;
    }

    /** @return array<string,mixed> */
    private static function find(int $siteId, array $p): array
    {
        $cid = filter_var($p['cid'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $row = $cid === false ? null : Db::one('SELECT ' . self::COLUMNS . ' FROM site_cron WHERE id = ? AND site_id = ?', [$cid, $siteId]);
        if (!$row) {
            throw new HttpException(404, 'Cron job not found');
        }
        return $row;
    }

    /** @param array<string,mixed> $r @return array<string,mixed> */
    private static function present(array $r): array
    {
        foreach (['next_run_at', 'last_run_at'] as $k) {
            $r[$k] = $r[$k] === null ? null : str_replace(' ', 'T', (string) $r[$k]) . 'Z';
        }
        foreach (['id', 'timeout_sec', 'last_job_id', 'last_duration_ms'] as $k) {
            $r[$k] = $r[$k] === null ? null : (int) $r[$k];
        }
        $r['last_exit'] = $r['last_exit'] === null ? null : (int) $r['last_exit'];
        $r['enabled'] = (bool) $r['enabled'];
        $r['notify_fail'] = (bool) $r['notify_fail'];
        return $r;
    }

    /** @return array{name:string,schedule:string,command:string,timeout_sec:int,enabled:int,notify_fail:int} */
    private static function input(Request $req): array
    {
        $in = $req->json();
        $name = trim((string) ($in['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > 100) {
            throw new HttpException(422, 'Please enter a name (max. 100 characters).');
        }
        $schedule = preg_replace('/\s+/', ' ', trim((string) ($in['schedule'] ?? ''))) ?? '';
        if ($err = Cron::validate($schedule)) {
            throw new HttpException(422, 'Schedule: ' . $err);
        }
        $command = trim((string) ($in['command'] ?? ''));
        if ($command === '' || strlen($command) > 1000 || str_contains($command, "\0")) {
            throw new HttpException(422, 'The command must not be empty and at most 1000 characters long.');
        }
        $timeout = (int) ($in['timeout_sec'] ?? 600);
        if ($timeout < 10 || $timeout > 3600) {
            throw new HttpException(422, 'The time limit must be between 10 and 3600 seconds.');
        }
        return [
            'name' => $name, 'schedule' => strtolower($schedule[0] ?? '') === '@' ? strtolower($schedule) : $schedule,
            'command' => $command, 'timeout_sec' => $timeout,
            'enabled' => !empty($in['enabled']) ? 1 : 0, 'notify_fail' => !array_key_exists('notify_fail', $in) || !empty($in['notify_fail']) ? 1 : 0,
        ];
    }

    public static function list(Request $req, array $p): never
    {
        $id = self::siteId($p);
        $rows = Db::all('SELECT ' . self::COLUMNS . ' FROM site_cron WHERE site_id = ? ORDER BY id', [$id]);
        Response::json(['crons' => array_map([self::class, 'present'], $rows), 'tz' => Env::get('TZ', 'UTC'), 'max' => self::MAX_PER_SITE]);
    }

    public static function create(Request $req, array $p): never
    {
        $id = self::siteId($p);
        if ((int) Db::val('SELECT COUNT(*) FROM site_cron WHERE site_id = ?', [$id]) >= self::MAX_PER_SITE) {
            throw new HttpException(422, 'At most ' . self::MAX_PER_SITE . ' cron jobs per website are possible.');
        }
        $d = self::input($req);
        $cid = Db::insert(
            'INSERT INTO site_cron (site_id, name, schedule, command, timeout_sec, enabled, notify_fail, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [$id, $d['name'], $d['schedule'], $d['command'], $d['timeout_sec'], $d['enabled'], $d['notify_fail'], \WebManager\Http\Auth::user()['id'] ?? null]
        );
        Audit::log('cron.create', "site-$id", ['cron' => $cid, 'name' => $d['name'], 'schedule' => $d['schedule']]);
        Response::json(['id' => $cid], 201);
    }

    public static function update(Request $req, array $p): never
    {
        $id = self::siteId($p);
        $old = self::find($id, $p);
        $d = self::input($req);
        // a changed schedule or a re-enabled job gets a fresh next run time (computed by the worker)
        $reset = $d['schedule'] !== $old['schedule'] || ($d['enabled'] === 1 && !(int) $old['enabled']);
        Db::exec(
            'UPDATE site_cron SET name = ?, schedule = ?, command = ?, timeout_sec = ?, enabled = ?, notify_fail = ?' . ($reset ? ', next_run_at = NULL' : '') . ' WHERE id = ? AND site_id = ?',
            [$d['name'], $d['schedule'], $d['command'], $d['timeout_sec'], $d['enabled'], $d['notify_fail'], (int) $old['id'], $id]
        );
        Audit::log('cron.update', "site-$id", ['cron' => (int) $old['id'], 'name' => $d['name']]);
        Response::json(['ok' => true]);
    }

    public static function delete(Request $req, array $p): never
    {
        $id = self::siteId($p);
        $old = self::find($id, $p);
        Db::exec('DELETE FROM site_cron WHERE id = ? AND site_id = ?', [(int) $old['id'], $id]);
        Audit::log('cron.delete', "site-$id", ['cron' => (int) $old['id'], 'name' => (string) $old['name']]);
        Response::json(['ok' => true]);
    }

    public static function run(Request $req, array $p): never
    {
        $id = self::siteId($p);
        $c = self::find($id, $p);
        if (Db::val("SELECT id FROM jobs WHERE type = 'site.cron' AND status IN ('queued','running','cancelling') AND JSON_VALUE(payload, '$.cronId') = ? LIMIT 1", [(string) $c['id']])) {
            throw new HttpException(409, 'This cron job is already running or waiting to run.');
        }
        $job = JobQueue::enqueue('site.cron', $id, 'Cron job: ' . $c['name'] . ' (manual)', ['cronId' => (int) $c['id']]);
        Audit::log('cron.run', "site-$id", ['cron' => (int) $c['id']]);
        Response::json(['job' => $job]);
    }
}
