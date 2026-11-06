<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Services\Agent;
use WebManager\Services\SiteService;
use WebManager\Support\Audit;

/** Thin proxy to the agent's confined file operations. The dashboard never touches site files itself. */
final class FileApi
{
    private static function id(array $p): int
    {
        $id = filter_var($p['id'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 40000]]);
        if ($id === false) {
            throw new HttpException(404, 'Website not found');
        }
        SiteService::row((int) $id);
        return (int) $id;
    }

    private static function path(Request $req): string
    {
        $path = $req->q('path');
        if (strlen($path) > 2048 || str_contains($path, "\0")) {
            throw new HttpException(422, 'Invalid path');
        }
        return $path;
    }

    /** A folder path inside the project: relative, without "..", at most 2048 characters. */
    private static function dir(mixed $v): string
    {
        $d = trim((string) $v, '/');
        if (strlen($d) > 2048 || str_contains($d, "\0") || in_array('..', explode('/', $d), true)) {
            throw new HttpException(422, 'Invalid path');
        }
        return $d;
    }

    private static function validName(string $n): bool
    {
        return $n !== '' && $n !== '.' && $n !== '..' && strlen($n) <= 255 && !preg_match("#[/\\\\\\x00-\\x1f]#", $n);
    }

    /** @return list<string> the selected names of a folder (no paths) */
    private static function names(mixed $v, int $max): array
    {
        if (!is_array($v) || $v === [] || count($v) > $max) {
            throw new HttpException(422, 'Please select between 1 and ' . $max . ' files or folders.');
        }
        $out = [];
        foreach ($v as $n) {
            if (!is_string($n) || !self::validName($n)) {
                throw new HttpException(422, 'Invalid file name');
            }
            $out[$n] = true;
        }
        return array_map('strval', array_keys($out));
    }

    private static function join(string $dir, string $name): string
    {
        return $dir === '' ? $name : $dir . '/' . $name;
    }

    public static function list(Request $req, array $p): never
    {
        $id = self::id($p);
        Response::json(Agent::get("/v1/sites/$id/fs/list?path=" . rawurlencode(self::path($req))));
    }

    public static function read(Request $req, array $p): never
    {
        $id = self::id($p);
        Response::json(Agent::get("/v1/sites/$id/fs/read?path=" . rawurlencode(self::path($req))));
    }

    public static function write(Request $req, array $p): never
    {
        $id = self::id($p);
        $path = self::path($req);
        $in = $req->json();
        if (!isset($in['content']) || !is_string($in['content'])) {
            throw new HttpException(422, 'Content missing');
        }
        $r = Agent::request('PUT', "/v1/sites/$id/fs/write?path=" . rawurlencode($path), null, $in['content'], 60);
        Audit::log('file.write', SiteService::siteName($id), ['path' => mb_substr($path, 0, 200)]);
        Response::json($r);
    }

    public static function upload(Request $req, array $p): never
    {
        $id = self::id($p);
        $dir = trim(self::path($req), '/');
        if (empty($_FILES['file']) || !is_array($_FILES['file']['name'])) {
            throw new HttpException(422, 'No file submitted');
        }
        $results = [];
        foreach ($_FILES['file']['name'] as $i => $name) {
            $err = $_FILES['file']['error'][$i];
            $name = basename((string) $name);
            if ($err !== UPLOAD_ERR_OK) {
                $results[] = ['name' => $name, 'ok' => false, 'error' => 'Upload error (code ' . $err . ')'];
                continue;
            }
            if ($name === '' || $name === '.' || $name === '..' || str_contains($name, "\0")) {
                $results[] = ['name' => $name, 'ok' => false, 'error' => 'Invalid file name'];
                continue;
            }
            $target = ($dir === '' ? '' : $dir . '/') . $name;
            try {
                Agent::putFile("/v1/sites/$id/fs/upload?path=" . rawurlencode($target), $_FILES['file']['tmp_name'][$i]);
                $results[] = ['name' => $name, 'ok' => true];
            } catch (HttpException $e) {
                $results[] = ['name' => $name, 'ok' => false, 'error' => $e->getMessage()];
            }
        }
        Audit::log('file.upload', SiteService::siteName($id), ['dir' => mb_substr($dir, 0, 200), 'count' => count($results)]);
        Response::json(['results' => $results]);
    }

    public static function mkdir(Request $req, array $p): never
    {
        $id = self::id($p);
        $in = $req->json();
        Response::json(Agent::request('POST', "/v1/sites/$id/fs/mkdir", ['path' => (string) ($in['path'] ?? '')]));
    }

    public static function rename(Request $req, array $p): never
    {
        $id = self::id($p);
        $in = $req->json();
        $r = Agent::request('POST', "/v1/sites/$id/fs/rename", ['path' => (string) ($in['path'] ?? ''), 'to' => (string) ($in['to'] ?? '')]);
        Audit::log('file.move', SiteService::siteName($id), ['path' => mb_substr((string) ($in['path'] ?? ''), 0, 200), 'to' => mb_substr((string) ($in['to'] ?? ''), 0, 200)]);
        Response::json($r);
    }

    public static function copy(Request $req, array $p): never
    {
        $id = self::id($p);
        $in = $req->json();
        $r = Agent::request('POST', "/v1/sites/$id/fs/copy", ['path' => (string) ($in['path'] ?? ''), 'to' => (string) ($in['to'] ?? '')], null, 120);
        Audit::log('file.copy', SiteService::siteName($id), ['path' => mb_substr((string) ($in['path'] ?? ''), 0, 200), 'to' => mb_substr((string) ($in['to'] ?? ''), 0, 200)]);
        Response::json($r);
    }

    public static function delete(Request $req, array $p): never
    {
        $id = self::id($p);
        $path = self::path($req);
        $r = Agent::request('DELETE', "/v1/sites/$id/fs?path=" . rawurlencode($path));
        Audit::log('file.delete', SiteService::siteName($id), ['path' => mb_substr($path, 0, 200)]);
        Response::json($r);
    }

    public static function download(Request $req, array $p): never
    {
        $id = self::id($p);
        $path = self::path($req);
        Agent::download("/v1/sites/$id/fs/download?path=" . rawurlencode($path), basename($path));
    }

    /** GET …/files/archive?path=<folder>&n[]=a&n[]=b: the selection as a ZIP download (read only, so a plain link works). */
    public static function archive(Request $req, array $p): never
    {
        $id = self::id($p);
        $dir = self::dir($req->q('path'));
        $names = self::names($req->query['n'] ?? null, 100);
        $base = count($names) === 1 ? $names[0] : (basename($dir) !== '' ? basename($dir) : 'website');
        $filename = $base . '.zip';
        Audit::log('file.archive', SiteService::siteName($id), ['dir' => mb_substr($dir, 0, 200), 'count' => count($names)]);
        Agent::download("/v1/sites/$id/fs/archive", $filename, ['dir' => $dir, 'names' => $names, 'filename' => $filename], 'application/zip');
    }

    /** POST …/files/zip {dir, names, name}: packs the selection into a ZIP file next to it (or in `target`). */
    public static function zip(Request $req, array $p): never
    {
        $id = self::id($p);
        $in = $req->json();
        $dir = self::dir($in['dir'] ?? '');
        $names = self::names($in['names'] ?? null, 1000);
        $name = trim((string) ($in['name'] ?? ''));
        if (!str_ends_with(strtolower($name), '.zip')) {
            $name .= '.zip';
        }
        if (!self::validName($name)) {
            throw new HttpException(422, 'Invalid name for the archive.');
        }
        $to = self::join($dir, $name);
        $r = Agent::request('POST', "/v1/sites/$id/fs/zip", ['dir' => $dir, 'names' => $names, 'to' => $to], null, 900);
        Audit::log('file.zip', SiteService::siteName($id), ['dir' => mb_substr($dir, 0, 200), 'archive' => mb_substr($name, 0, 200), 'count' => count($names)]);
        Response::json($r + ['name' => $name]);
    }

    /** POST …/files/batch {action: delete|move, dir, names, to?}: the same action for several files; every file has its own result. */
    public static function batch(Request $req, array $p): never
    {
        $id = self::id($p);
        $in = $req->json();
        $action = (string) ($in['action'] ?? '');
        if (!in_array($action, ['delete', 'move'], true)) {
            throw new HttpException(422, 'Unknown action');
        }
        $dir = self::dir($in['dir'] ?? '');
        $names = self::names($in['names'] ?? null, 200);
        $to = $action === 'move' ? self::dir($in['to'] ?? '') : '';
        if ($action === 'move' && $to === $dir) {
            throw new HttpException(422, 'The files are already in this folder.');
        }
        $results = [];
        foreach ($names as $n) {
            $src = self::join($dir, $n);
            try {
                if ($action === 'delete') {
                    Agent::request('DELETE', "/v1/sites/$id/fs?path=" . rawurlencode($src));
                } else {
                    if ($to === $src || str_starts_with($to . '/', $src . '/')) {
                        throw new HttpException(422, 'A folder cannot be moved into itself');
                    }
                    Agent::request('POST', "/v1/sites/$id/fs/rename", ['path' => $src, 'to' => self::join($to, $n)]);
                }
                $results[] = ['name' => $n, 'ok' => true];
            } catch (HttpException $e) {
                $results[] = ['name' => $n, 'ok' => false, 'error' => $e->getMessage()];
            }
        }
        Audit::log('file.' . $action . '_many', SiteService::siteName($id), ['dir' => mb_substr($dir, 0, 200), 'to' => mb_substr($to, 0, 200), 'count' => count($names), 'failed' => count(array_filter($results, static fn (array $r): bool => !$r['ok']))]);
        Response::json(['results' => $results]);
    }
}
