<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\Agent;
use WebManager\Services\JobQueue;
use WebManager\Support\Audit;

/** Storage overview and cleanup (administrators only, see Permissions). The agent decides what may be removed; only category ids travel. */
final class StorageApi
{
    private const CATEGORIES = ['images', 'dangling', 'buildcache', 'appbackups', 'dumps', 'logs', 'trash'];

    public static function show(Request $req): never
    {
        Response::json(Agent::get('/v1/storage', 120));
    }

    public static function sites(Request $req): never
    {
        Response::json(Agent::get('/v1/storage/sites', 180));
    }

    public static function cleanup(Request $req): never
    {
        $in = $req->json()['categories'] ?? null;
        if (!is_array($in) || !$in) {
            throw new HttpException(422, 'Please choose at least one category.');
        }
        $cats = [];
        foreach ($in as $c) {
            if (!is_string($c) || !in_array($c, self::CATEGORIES, true)) {
                throw new HttpException(422, 'Unknown category.');
            }
            $cats[$c] = true;
        }
        $cats = array_keys($cats);
        $job = JobQueue::enqueue('system.cleanup', null, 'Clean up storage', ['categories' => $cats]);
        Audit::log('storage.cleanup', implode(',', $cats));
        Response::json(['job' => $job]);
    }
}
