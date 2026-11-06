<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;

/**
 * Language files of the interface (lang/<code>.json). Public, because the sign-in page is translated too; the files contain only
 * interface texts. The code is checked against a strict pattern, so no other file can be read.
 */
final class LangApi
{
    private const CODE = '/^[a-z]{2,3}(-[A-Z]{2})?$/';

    /** @return array{name:string,locale:string,strings:array<string,string>}|null */
    public static function load(string $code, ?string $dir = null): ?array
    {
        $dir ??= WM_ROOT . '/lang';
        if (!preg_match(self::CODE, $code) || !is_file("$dir/$code.json") || filesize("$dir/$code.json") > 2097152) {
            return null;
        }
        $j = json_decode((string) file_get_contents("$dir/$code.json"), true, 8);
        $meta = is_array($j) ? ($j['_meta'] ?? null) : null;
        if (!is_array($meta) || !is_string($meta['name'] ?? null) || !is_string($meta['locale'] ?? null) || !preg_match('/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/', $meta['locale'])) {
            return null;
        }
        $strings = [];
        foreach ((array) ($j['strings'] ?? []) as $k => $v) {
            if (is_string($k) && is_string($v) && trim($v) !== '') {
                $strings[$k] = $v;
            }
        }
        return ['name' => $meta['name'], 'locale' => $meta['locale'], 'strings' => $strings];
    }

    /** @return list<array{code:string,name:string,locale:string}> */
    public static function languages(?string $dir = null): array
    {
        $dir ??= WM_ROOT . '/lang';
        $out = [];
        foreach (glob("$dir/*.json") ?: [] as $f) {
            $code = basename($f, '.json');
            $l = self::load($code, $dir);
            if ($l !== null) {
                $out[] = ['code' => $code, 'name' => $l['name'], 'locale' => $l['locale']];
            }
        }
        usort($out, static fn (array $a, array $b): int => strcmp($a['name'], $b['name']));
        return $out;
    }

    public static function index(Request $req): never
    {
        Response::json(['languages' => self::languages()]);
    }

    public static function show(Request $req, array $p): never
    {
        $l = self::load((string) ($p['code'] ?? ''));
        if ($l === null) {
            throw new HttpException(404, 'Unknown language.');
        }
        Response::json(['locale' => $l['locale'], 'strings' => $l['strings']]);
    }
}
