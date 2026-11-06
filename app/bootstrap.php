<?php
declare(strict_types=1);

// PSR-4 style autoloader: WebManager\Http\Request -> app/Http/Request.php
spl_autoload_register(static function (string $class): void {
    $prefix = 'WebManager\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $file = __DIR__ . '/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    if (is_file($file)) {
        require $file;
    }
});

define('WM_ROOT', dirname(__DIR__));
define('WM_VERSION', trim((string) @file_get_contents(WM_ROOT . '/VERSION')) ?: 'dev');

date_default_timezone_set('UTC');
mb_internal_encoding('UTF-8');

set_error_handler(static function (int $no, string $str, string $file, int $line): bool {
    if (!(error_reporting() & $no)) {
        return false;
    }
    throw new ErrorException($str, 0, $no, $file, $line);
});

/** HTML-escape helper for views. */
function e(mixed $v): string
{
    return htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** Asset URL with a content-based cache buster, so browsers never serve stale CSS/JS after an update. */
function asset(string $path): string
{
    $file = WM_ROOT . '/public/assets/' . ltrim($path, '/');
    $v = is_file($file) ? substr(md5_file($file) ?: '', 0, 10) : rawurlencode(WM_VERSION);
    return '/assets/' . ltrim($path, '/') . '?v=' . $v;
}
