<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Support\Audit;
use WebManager\Support\Brand;
use WebManager\Support\Db;

/**
 * Name, logo and accent colour of the dashboard (administrators only, see Permissions). The two public endpoints
 * below serve the logo and the colour stylesheet to the login page, which has no session yet.
 */
final class BrandingApi
{
    /** @return array<string,mixed> */
    private static function state(): array
    {
        Brand::reset();
        $b = Brand::load();
        return [
            'name' => $b['name'], 'defaultName' => Brand::DEFAULT_NAME, 'color' => $b['color'], 'hasLogo' => $b['logo'] !== null,
            'logoUrl' => Brand::logoUrl(), 'product' => Brand::PRODUCT,
        ];
    }

    public static function show(Request $req): never
    {
        Response::json(self::state());
    }

    public static function update(Request $req): never
    {
        $in = $req->json();
        $name = trim((string) ($in['name'] ?? ''));
        $color = trim((string) ($in['color'] ?? ''));
        $errors = [];
        if (($e = Brand::validName($name)) !== null) {
            $errors['name'] = $e;
        }
        if (($e = Brand::validColor($color)) !== null) {
            $errors['color'] = $e;
        }
        if ($errors !== []) {
            throw new HttpException(422, reset($errors), ['fields' => $errors]);
        }
        Db::exec('REPLACE INTO settings (k, v) VALUES (?, ?)', ['brand_name', $name]);
        if ($color === '') {
            Db::exec("DELETE FROM settings WHERE k = 'brand_color'");
        } else {
            Db::exec('REPLACE INTO settings (k, v) VALUES (?, ?)', ['brand_color', strtolower($color)]);
        }
        Audit::log('settings.branding', 'name', ['name' => $name, 'color' => $color]);
        Response::json(self::state());
    }

    public static function putLogo(Request $req): never
    {
        $f = $_FILES['logo'] ?? null;
        if (!is_array($f) || ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file((string) $f['tmp_name'])) {
            throw new HttpException(422, 'Please choose an image file.');
        }
        $data = (string) file_get_contents((string) $f['tmp_name']);
        $check = Brand::checkLogo($data);
        if (is_string($check)) {
            throw new HttpException(422, $check);
        }
        Db::exec('REPLACE INTO brand_assets (k, mime, data, etag) VALUES (?, ?, ?, ?)', ['logo', $check['mime'], $data, substr(sha1($data), 0, 16)]);
        Audit::log('settings.branding_logo', 'logo', ['mime' => $check['mime'], 'bytes' => strlen($data)]);
        Response::json(self::state());
    }

    public static function deleteLogo(Request $req): never
    {
        Db::exec("DELETE FROM brand_assets WHERE k = 'logo'");
        Audit::log('settings.branding_logo', 'logo', ['removed' => true]);
        Response::json(self::state());
    }

    /** Back to the default appearance (name, colour and logo). */
    public static function reset(Request $req): never
    {
        Db::exec("DELETE FROM settings WHERE k IN ('brand_name', 'brand_color')");
        Db::exec("DELETE FROM brand_assets WHERE k = 'logo'");
        Audit::log('settings.branding_reset', 'branding');
        Response::json(self::state());
    }

    // ---- public ------------------------------------------------------------------------------------------------

    public static function logo(Request $req): never
    {
        $row = Db::one("SELECT mime, data, etag FROM brand_assets WHERE k = 'logo'");
        if ($row === null) {
            throw new HttpException(404, 'Not found');
        }
        $etag = '"' . $row['etag'] . '"';
        header('ETag: ' . $etag);
        // the logo URL carries ?v=<etag>, so a long cache time is safe; the sandbox keeps an SVG from running anything
        header('Cache-Control: public, max-age=86400');
        header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox");
        header('X-Content-Type-Options: nosniff');
        if ($req->header('If-None-Match') === $etag) {
            http_response_code(304);
            exit;
        }
        header('Content-Type: ' . $row['mime']);
        echo $row['data'];
        exit;
    }

    public static function theme(Request $req): never
    {
        header('Content-Type: text/css; charset=utf-8');
        header('Cache-Control: public, max-age=86400');
        header('X-Content-Type-Options: nosniff');
        echo Brand::css(Brand::load()['color']);
        exit;
    }
}
