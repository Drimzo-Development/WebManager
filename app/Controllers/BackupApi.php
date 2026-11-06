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
 * Backups page: state of local and external backups and the restore test (administrators only, see Permissions).
 * The work runs on the host through the backup helper; credentials of the external target are never visible here.
 */
final class BackupApi
{
    /** A "running" state older than this is treated as abandoned (host rebooted or helper killed). */
    private const STALE_AFTER = 21600;

    private const TITLES = [
        'backup' => 'Create backup',
        'upload' => 'Upload backup to the external target',
        'verify' => 'Restore test of the local backup',
        'verify-remote' => 'Restore test of the backup from the external target',
    ];

    /** @return array<string,mixed> */
    private static function load(): array
    {
        $s = Agent::get('/v1/backup', 20);
        $state = is_array($s['state'] ?? null) ? $s['state'] : null;
        $age = $state && !empty($state['at']) ? time() - (int) strtotime((string) $state['at']) : PHP_INT_MAX;
        $s['running'] = $state !== null && ($state['state'] ?? '') === 'running' && $age < self::STALE_AFTER;
        return $s;
    }

    public static function show(Request $req): never
    {
        Response::json(self::load());
    }

    public static function run(Request $req): never
    {
        $action = (string) ($req->json()['action'] ?? '');
        if (!isset(self::TITLES[$action])) {
            throw new HttpException(422, 'Unknown action.');
        }
        $s = self::load();
        if (!$s['canApply']) {
            throw new HttpException(409, 'The backup helper on the server is not active. Run on the server: sudo /opt/webmanager/scripts/backup-remote.sh install');
        }
        if (in_array($action, ['upload', 'verify-remote'], true) && empty($s['configured'])) {
            throw new HttpException(422, 'No external target has been set up yet.');
        }
        if ($s['running'] || !empty($s['requestPending'])) {
            throw new HttpException(409, 'A backup operation is already running.');
        }
        $job = JobQueue::enqueue('system.backup', null, self::TITLES[$action], ['action' => $action]);
        Audit::log('backup.' . $action, 'system');
        Response::json(['job' => $job]);
    }
}
