<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\Agent;
use WebManager\Services\JobQueue;
use WebManager\Support\Audit;

/**
 * Update notice and "Update now" (administrators only, see Permissions).
 * Release data comes from the host-side update helper through the agent; the update itself runs on the host.
 */
final class UpdateApi
{
    /** A "running" state older than this is treated as abandoned (host rebooted or helper killed). */
    private const STALE_AFTER = 10800;

    /** @return array<string,mixed> */
    private static function load(): array
    {
        $s = Agent::get('/v1/update', 20);
        $releases = array_values(array_filter((array) ($s['releases'] ?? []), static fn ($r) => is_array($r) && isset($r['version'])));
        $newer = array_values(array_filter($releases, static fn ($r) => version_compare((string) $r['version'], WM_VERSION, '>')));
        usort($newer, static fn ($a, $b) => version_compare((string) $b['version'], (string) $a['version']));
        $state = is_array($s['state'] ?? null) ? $s['state'] : null;
        $age = $state && !empty($state['at']) ? time() - (int) strtotime((string) $state['at']) : PHP_INT_MAX;
        $running = $state !== null && ($state['state'] ?? '') === 'running' && $age < self::STALE_AFTER;
        return [
            'current' => WM_VERSION,
            'helperInstalled' => (bool) ($s['helperInstalled'] ?? false),
            'canApply' => (bool) ($s['canApply'] ?? false),
            'checkedAt' => (string) ($s['checkedAt'] ?? ''),
            'checkError' => (string) ($s['checkError'] ?? ''),
            'supported' => (bool) ($s['supported'] ?? true),
            'minSupported' => (string) ($s['minSupported'] ?? ''),
            'available' => $newer !== [],
            'latest' => $newer[0]['version'] ?? null,
            'releases' => $newer,
            'state' => $state,
            'running' => $running,
            'requestPending' => (bool) ($s['requestPending'] ?? false),
            'logTail' => (string) ($s['logTail'] ?? ''),
            'auto' => is_array($s['auto'] ?? null) ? $s['auto'] : ['mode' => 'off', 'from' => 2, 'to' => 5],
            'autoState' => is_array($s['autoState'] ?? null) ? $s['autoState'] : null,
            'rollback' => is_array($s['rollback'] ?? null) ? $s['rollback'] : ['available' => false],
        ];
    }

    public static function show(Request $req): never
    {
        Response::json(self::load());
    }

    /** Automatic updates of patch versions: off, or on inside a time window (full hours, server time). */
    public static function setAuto(Request $req): never
    {
        $in = $req->json();
        $mode = (string) ($in['mode'] ?? '');
        if (!in_array($mode, ['off', 'patch'], true)) {
            throw new HttpException(422, 'Invalid selection.');
        }
        $from = filter_var($in['from'] ?? 2, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 23]]);
        $to = filter_var($in['to'] ?? 5, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 23]]);
        if ($from === false || $to === false) {
            throw new HttpException(422, 'The times must be full hours between 0 and 23.');
        }
        if (!self::load()['canApply']) {
            throw new HttpException(409, 'The update helper on the server is not active. Run the update on the server with update.sh.');
        }
        $job = JobQueue::enqueue('system.update', null, $mode === 'patch' ? 'Switch on automatic updates' : 'Switch off automatic updates', ['action' => 'auto', 'mode' => $mode, 'from' => (int) $from, 'to' => (int) $to]);
        Audit::log('update.auto', $mode, ['from' => (int) $from, 'to' => (int) $to]);
        Response::json(['job' => $job]);
    }

    /** Go back to the version before the last update (program files and database from before it). The host decides what to restore. */
    public static function rollback(Request $req): never
    {
        $status = self::load();
        if (!$status['canApply']) {
            throw new HttpException(409, 'The update helper on the server is not active. Run on the server: sudo /opt/webmanager/scripts/rollback.sh');
        }
        if ($status['running'] || $status['requestPending']) {
            throw new HttpException(409, 'An update or rollback is already running.');
        }
        if (empty($status['rollback']['available'])) {
            throw new HttpException(422, 'Rolling back is not possible: there is no matching backup of the state before the last update.');
        }
        if ((string) ($req->json()['confirm'] ?? '') !== 'ZURUECKSETZEN') {
            throw new HttpException(422, 'Please enter the confirmation ZURUECKSETZEN.');
        }
        $to = (string) $status['rollback']['version'];
        $job = JobQueue::enqueue('system.update', null, "Roll back to version $to", ['action' => 'rollback']);
        Audit::log('update.rollback', $to, ['from' => WM_VERSION]);
        Response::json(['job' => $job, 'version' => $to]);
    }

    public static function check(Request $req): never
    {
        $job = JobQueue::enqueue('system.update', null, 'Check for new versions', ['action' => 'check']);
        Audit::log('update.check', 'system');
        Response::json(['job' => $job]);
    }

    public static function apply(Request $req): never
    {
        $in = $req->json();
        $status = self::load();
        if (!$status['canApply']) {
            throw new HttpException(409, 'The update helper on the server is not active. Run the update on the server with update.sh.');
        }
        if ($status['running'] || $status['requestPending']) {
            throw new HttpException(409, 'An update is already running.');
        }
        $version = (string) ($in['version'] ?? $status['latest'] ?? '');
        $known = array_column($status['releases'], 'version');
        if ($version === '' || !in_array($version, $known, true)) {
            throw new HttpException(422, 'This version is not available.');
        }
        $job = JobQueue::enqueue('system.update', null, "Request update to version $version", ['action' => 'update', 'version' => $version]);
        Audit::log('update.apply', $version, ['from' => WM_VERSION]);
        Response::json(['job' => $job, 'version' => $version]);
    }
}
