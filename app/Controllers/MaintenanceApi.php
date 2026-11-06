<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\SiteService;
use WebManager\Support\Audit;
use WebManager\Support\Db;
use WebManager\Support\Maintenance;

/** Maintenance windows (operators): while one is active, notifications about the website (or about everything) are muted. */
final class MaintenanceApi
{
    private const MAX = 200;

    private static function ts(string $db): int
    {
        return (int) strtotime($db . ' UTC');
    }

    /** @param array<string,mixed> $r @return array<string,mixed> */
    private static function present(array $r, int $now): array
    {
        $w = ['starts' => self::ts((string) $r['starts_at']), 'ends' => self::ts((string) $r['ends_at']), 'repeat' => (string) $r['repeat_every']];
        $iso = static fn (?int $t): ?string => $t === null ? null : gmdate('Y-m-d\TH:i:s\Z', $t);
        $cur = Maintenance::currentStart($w, $now);
        $next = Maintenance::nextStart($w, $now);
        return [
            'id' => (int) $r['id'], 'site_id' => $r['site_id'] === null ? null : (int) $r['site_id'], 'site_name' => $r['site_name'] ?? null,
            'title' => (string) $r['title'], 'starts_at' => $iso($w['starts']), 'ends_at' => $iso($w['ends']), 'repeat' => $w['repeat'],
            'active' => $cur !== null,
            'current_end' => $cur === null ? null : $iso($cur + ($w['ends'] - $w['starts'])),
            'next_start' => $next === null || $cur !== null ? null : $iso($next),
        ];
    }

    public static function list(Request $req): never
    {
        $now = time();
        $rows = Db::all('SELECT m.*, s.name AS site_name FROM maintenance_windows m LEFT JOIN sites s ON s.id = m.site_id ORDER BY m.starts_at DESC LIMIT ' . self::MAX);
        $out = array_map(static fn (array $r): array => self::present($r, $now), $rows);
        // running first, then upcoming (soonest first), then finished
        $key = static fn (array $x): array => $x['active'] ? [0, 0] : ($x['next_start'] !== null ? [1, strtotime($x['next_start'])] : [2, -strtotime($x['ends_at'])]);
        usort($out, static fn (array $a, array $b): int => $key($a) <=> $key($b));
        Response::json(['windows' => $out, 'max' => self::MAX]);
    }

    private static function parseTime(mixed $v, string $label): int
    {
        try {
            $d = new \DateTimeImmutable((string) $v);
        } catch (\Throwable) {
            throw new HttpException(422, $label . ': please enter a valid date and time.');
        }
        return $d->getTimestamp();
    }

    public static function create(Request $req): never
    {
        $in = $req->json();
        $title = trim((string) ($in['title'] ?? ''));
        if ($title === '' || mb_strlen($title) > 80) {
            throw new HttpException(422, 'Please enter a title (max. 80 characters).');
        }
        $siteId = null;
        if (isset($in['site_id']) && $in['site_id'] !== '' && $in['site_id'] !== null) {
            $siteId = filter_var($in['site_id'], FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 40000]]);
            if ($siteId === false) {
                throw new HttpException(422, 'Unknown website.');
            }
            SiteService::row((int) $siteId);
        }
        $w = [
            'starts' => self::parseTime($in['starts_at'] ?? '', 'Start'), 'ends' => self::parseTime($in['ends_at'] ?? '', 'End'),
            'repeat' => (string) ($in['repeat'] ?? 'none'),
        ];
        if ($err = Maintenance::validate($w)) {
            throw new HttpException(422, $err);
        }
        if ($w['ends'] < time() && $w['repeat'] === 'none') {
            throw new HttpException(422, 'The window lies in the past.');
        }
        if ((int) (Db::one('SELECT COUNT(*) AS n FROM maintenance_windows')['n'] ?? 0) >= self::MAX) {
            throw new HttpException(422, 'Maximum number of maintenance windows reached. Delete old ones first.');
        }
        $uid = \WebManager\Http\Auth::user()['id'] ?? null;
        $id = Db::insert(
            'INSERT INTO maintenance_windows (site_id, title, starts_at, ends_at, repeat_every, created_by) VALUES (?,?,?,?,?,?)',
            [$siteId === null ? null : (int) $siteId, $title, gmdate('Y-m-d H:i:s', $w['starts']), gmdate('Y-m-d H:i:s', $w['ends']), $w['repeat'], $uid]
        );
        Audit::log('maintenance.create', $title, ['site' => $siteId, 'repeat' => $w['repeat']]);
        Response::json(['id' => $id], 201);
    }

    public static function delete(Request $req, array $p): never
    {
        $id = filter_var($p['id'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $row = $id === false ? null : Db::one('SELECT id, title FROM maintenance_windows WHERE id = ?', [$id]);
        if (!$row) {
            throw new HttpException(404, 'Maintenance window not found');
        }
        Db::exec('DELETE FROM maintenance_windows WHERE id = ?', [$id]);
        Audit::log('maintenance.delete', (string) $row['title']);
        Response::json(['ok' => true]);
    }
}
