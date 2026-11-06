<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\Agent;
use WebManager\Services\SiteService;
use WebManager\Support\Db;
use WebManager\Support\Metrics;

/**
 * GET /api/v1/metrics: resources and availability of all websites in the Prometheus text format, for Grafana and Alertmanager.
 * It is a normal API v1 route: it needs an API token (Authorization: Bearer …) or a session, a viewer account is enough.
 */
final class MetricsApi
{
    public static function show(Request $req): never
    {
        $m = new Metrics();
        $statuses = [];
        $stats = [];
        $agentUp = 1;
        try {
            $statuses = Agent::get('/v1/statuses', 20)['statuses'] ?? [];
            $stats = Agent::get('/v1/stats', 20)['stats'] ?? [];
        } catch (HttpException) {
            $agentUp = 0;
        }
        $m->add('webmanager_info', 'gauge', 'Version of WebManager (value is always 1).', ['version' => WM_VERSION], 1);
        $m->add('webmanager_agent_up', 'gauge', '1 if the dashboard can reach the agent, 0 if not.', [], $agentUp);

        $checks = [];
        foreach (Db::all('SELECT site_id, COUNT(*) AS n, SUM(ok) AS up, AVG(CASE WHEN ok = 1 THEN ms END) AS ms FROM site_checks WHERE checked_at > NOW() - INTERVAL 24 HOUR GROUP BY site_id') as $c) {
            $checks[(int) $c['site_id']] = $c;
        }
        $last = [];
        foreach (Db::all('SELECT c.site_id, c.ok, c.status_code, c.ms FROM site_checks c
                          JOIN (SELECT site_id, MAX(id) AS mid FROM site_checks WHERE checked_at > NOW() - INTERVAL 10 MINUTE GROUP BY site_id) x ON x.mid = c.id') as $c) {
            $last[(int) $c['site_id']] = $c;
        }
        $disk = [];
        foreach (Db::all('SELECT d.site_id, d.bytes FROM site_disk d JOIN (SELECT site_id, MAX(day) AS md FROM site_disk GROUP BY site_id) x ON x.site_id = d.site_id AND x.md = d.day') as $d) {
            $disk[(int) $d['site_id']] = (int) $d['bytes'];
        }
        $certs = [];
        foreach (Db::all('SELECT name, not_after FROM certificates WHERE not_after IS NOT NULL') as $c) {
            $certs[$c['name']] = strtotime((string) $c['not_after'] . ' UTC') ?: null;
        }

        foreach (Db::all('SELECT id, name, type, runtime, memory_mb, desired_state, lifecycle, maintenance_enabled FROM sites ORDER BY id') as $s) {
            $id = (int) $s['id'];
            $l = ['site' => SiteService::siteName($id), 'name' => (string) $s['name']];
            $st = $agentUp ? ($statuses[(string) $id] ?? null) : null;
            $m->add('webmanager_site_info', 'gauge', 'Websites (value is always 1).', $l + ['type' => (string) $s['type'], 'runtime' => (string) $s['runtime']], 1);
            $m->add('webmanager_site_desired_running', 'gauge', '1 if the website is meant to run.', $l, $s['desired_state'] === 'running' ? 1 : 0);
            $m->add('webmanager_site_maintenance', 'gauge', '1 if the maintenance page is switched on.', $l, (int) $s['maintenance_enabled'] === 1 ? 1 : 0);
            if ($st !== null) {
                $m->add('webmanager_site_running', 'gauge', '1 if the container is running.', $l, ($st['state'] ?? '') === 'running' ? 1 : 0);
                $m->add('webmanager_site_container_restarts_total', 'counter', 'Restarts of the container since it was created.', $l, isset($st['restartCount']) ? (int) $st['restartCount'] : null);
                $m->add('webmanager_site_oom_killed', 'gauge', '1 if the last stop was caused by memory exhaustion.', $l, isset($st['oomKilled']) ? (int) (bool) $st['oomKilled'] : null);
            }
            $u = $stats[(string) $id] ?? null;
            if (is_array($u)) {
                $m->add('webmanager_site_cpu_percent', 'gauge', 'CPU use of the container in percent of one core.', $l, (float) ($u['cpuPercent'] ?? 0));
                $m->add('webmanager_site_memory_usage_bytes', 'gauge', 'Memory use of the container.', $l, (int) ($u['memBytes'] ?? 0));
                $m->add('webmanager_site_memory_limit_bytes', 'gauge', 'Memory limit of the container.', $l, (int) ($u['memLimitBytes'] ?? 0));
                $m->add('webmanager_site_processes', 'gauge', 'Processes and threads in the container.', $l, (int) ($u['pids'] ?? 0));
            }
            $m->add('webmanager_site_disk_bytes', 'gauge', 'Disk space of the files (measured once a day).', $l, $disk[$id] ?? null);
            if (isset($last[$id])) {
                $m->add('webmanager_site_up', 'gauge', 'Result of the latest HTTP check (1 up, 0 down); left out when there is no recent check.', $l, (int) $last[$id]['ok']);
                $m->add('webmanager_site_http_status', 'gauge', 'HTTP status code of the latest check.', $l, $last[$id]['status_code'] === null ? null : (int) $last[$id]['status_code']);
                $m->add('webmanager_site_response_seconds', 'gauge', 'Response time of the latest check.', $l, $last[$id]['ms'] === null ? null : (int) $last[$id]['ms'] / 1000);
            }
            if (isset($checks[$id])) {
                $m->add('webmanager_site_availability_ratio_24h', 'gauge', 'Share of successful HTTP checks in the last 24 hours (0 to 1).', $l, (int) $checks[$id]['up'] / max(1, (int) $checks[$id]['n']));
            }
            $m->add('webmanager_site_certificate_expiry_timestamp_seconds', 'gauge', 'Expiry of the TLS certificate as Unix time.', $l, $certs[SiteService::siteName($id)] ?? null);
        }
        Response::text($m->render(), Metrics::CONTENT_TYPE);
    }
}
