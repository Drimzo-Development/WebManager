<?php
declare(strict_types=1);

namespace WebManager\Http;

final class Router
{
    /** @var list<array{string,string,callable,bool}> */
    private array $routes = [];

    public function add(string $method, string $pattern, callable $handler, bool $auth = true): void
    {
        $re = '#^' . preg_replace('#\{([a-z_]+)\}#', '(?P<$1>[^/]+)', $pattern) . '$#';
        $this->routes[] = [$method, $re, $handler, $auth];
    }

    /** @return array{callable,array<string,string>,bool}|null */
    public function match(string $method, string $path): ?array
    {
        foreach ($this->routes as [$m, $re, $handler, $auth]) {
            if ($m === $method && preg_match($re, $path, $mm)) {
                $params = array_filter($mm, 'is_string', ARRAY_FILTER_USE_KEY);
                return [$handler, $params, $auth];
            }
        }
        return null;
    }

    public function pathExists(string $path): bool
    {
        foreach ($this->routes as [, $re]) {
            if (preg_match($re, $path)) {
                return true;
            }
        }
        return false;
    }
}
