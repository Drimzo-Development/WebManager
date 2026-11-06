<?php
declare(strict_types=1);

namespace WebManager\Services;

use WebManager\Http\Auth;
use WebManager\Http\HttpException;
use WebManager\Support\Db;

final class JobQueue
{
    /** @param array<string,mixed> $payload */
    public static function enqueue(string $type, ?int $siteId, string $title, array $payload = []): int
    {
        $user = Auth::user();
        return Db::insert(
            'INSERT INTO jobs (type, site_id, title, payload, created_by) VALUES (?, ?, ?, ?, ?)',
            [$type, $siteId, mb_substr($title, 0, 200), json_encode($payload ?: new \stdClass(), JSON_UNESCAPED_UNICODE), $user['id'] ?? null]
        );
    }

    /** @return array<string,mixed> */
    public static function get(int $id): array
    {
        $j = Db::one('SELECT id, type, site_id, title, status, exit_code, error, created_at, started_at, finished_at FROM jobs WHERE id = ?', [$id]);
        if (!$j) {
            throw new HttpException(404, 'Task not found');
        }
        return self::format($j);
    }

    /** @return list<array<string,mixed>> */
    public static function recent(?int $siteId, int $limit = 30): array
    {
        $limit = max(1, min($limit, 200));
        $rows = $siteId === null
            ? Db::all("SELECT id, type, site_id, title, status, exit_code, error, created_at, started_at, finished_at FROM jobs ORDER BY id DESC LIMIT $limit")
            : Db::all("SELECT id, type, site_id, title, status, exit_code, error, created_at, started_at, finished_at FROM jobs WHERE site_id = ? ORDER BY id DESC LIMIT $limit", [$siteId]);
        return array_map([self::class, 'format'], $rows);
    }

    /** @return array{lines:list<array{id:int,line:string}>,status:string,finished:bool} */
    public static function logs(int $id, int $after): array
    {
        $job = self::get($id);
        $lines = Db::all('SELECT id, line FROM job_logs WHERE job_id = ? AND id > ? ORDER BY id LIMIT 500', [$id, $after]);
        foreach ($lines as &$l) {
            $l['id'] = (int) $l['id'];
        }
        return [
            'lines' => $lines,
            'status' => $job['status'],
            'finished' => in_array($job['status'], ['succeeded', 'failed', 'cancelled'], true),
        ];
    }

    public static function cancel(int $id): string
    {
        $n = Db::exec("UPDATE jobs SET status = 'cancelled', finished_at = NOW() WHERE id = ? AND status = 'queued'", [$id]);
        if ($n > 0) {
            return 'cancelled';
        }
        $n = Db::exec("UPDATE jobs SET status = 'cancelling' WHERE id = ? AND status = 'running'", [$id]);
        if ($n > 0) {
            return 'cancelling';
        }
        throw new HttpException(409, 'The task is no longer running and cannot be cancelled.');
    }

    public static function hasActive(int $siteId): bool
    {
        return (int) Db::val("SELECT COUNT(*) FROM jobs WHERE site_id = ? AND status IN ('queued','running','cancelling')", [$siteId]) > 0;
    }

    /** @param array<string,mixed> $j @return array<string,mixed> */
    private static function format(array $j): array
    {
        $j['id'] = (int) $j['id'];
        $j['site_id'] = $j['site_id'] === null ? null : (int) $j['site_id'];
        foreach (['created_at', 'started_at', 'finished_at'] as $k) {
            $j[$k] = $j[$k] ? str_replace(' ', 'T', (string) $j[$k]) . 'Z' : null;
        }
        return $j;
    }
}
