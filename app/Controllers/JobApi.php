<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\Auth;
use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\JobQueue;
use WebManager\Support\Audit;

final class JobApi
{
    private static function id(array $p): int
    {
        $id = filter_var($p['id'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($id === false) {
            throw new HttpException(404, 'Task not found');
        }
        return (int) $id;
    }

    public static function list(Request $req): never
    {
        $limit = (int) $req->q('limit', '50');
        Response::json(['jobs' => JobQueue::recent(null, $limit)]);
    }

    public static function show(Request $req, array $p): never
    {
        Response::json(['job' => JobQueue::get(self::id($p))]);
    }

    /** Short-polling endpoint: returns immediately with new log lines (no long-lived PHP request). */
    public static function logs(Request $req, array $p): never
    {
        $data = JobQueue::logs(self::id($p), max(0, (int) $req->q('after', '0')));
        $data['job'] = JobQueue::get(self::id($p));
        Response::json($data);
    }

    public static function cancel(Request $req, array $p): never
    {
        $id = self::id($p);
        $state = JobQueue::cancel($id);
        Audit::log('job.cancel', "job-$id", ['result' => $state]);
        Response::json(['status' => $state]);
    }
}
