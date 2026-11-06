<?php
declare(strict_types=1);

namespace WebManager\Support;

final class View
{
    /** Renders app/Views/<name>.php and returns the HTML. @param array<string,mixed> $vars */
    public static function partial(string $name, array $vars = []): string
    {
        if (!preg_match('/^[a-z_\/]+$/', $name)) {
            throw new \InvalidArgumentException('bad view name');
        }
        extract($vars, EXTR_SKIP);
        ob_start();
        require WM_ROOT . '/app/Views/' . $name . '.php';
        return (string) ob_get_clean();
    }
}
