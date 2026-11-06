<?php
declare(strict_types=1);

namespace WebManager\Http;

final class Request
{
    private ?array $json = null;

    /** @param array<string,string> $query */
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $query,
        private readonly array $server,
        private readonly array $post = [],
    ) {
    }

    public static function fromGlobals(): self
    {
        $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
        $path = rawurldecode((string) parse_url($uri, PHP_URL_PATH));
        if ($path === '' || $path[0] !== '/') {
            $path = '/';
        }
        return new self(strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')), $path, $_GET, $_SERVER, $_POST);
    }

    /** Same request for another path (used to map /api/v1 routes onto the internal ones). */
    public function withPath(string $path): self
    {
        return new self($this->method, $path, $this->query, $this->server, $this->post);
    }

    public function header(string $name): string
    {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        return (string) ($this->server[$key] ?? '');
    }

    public function ip(): string
    {
        $ip = (string) ($this->server['REMOTE_ADDR'] ?? '');
        return filter_var($ip, FILTER_VALIDATE_IP) ? $ip : '0.0.0.0';
    }

    public function isHttps(): bool
    {
        return ($this->server['HTTPS'] ?? '') === 'on' || strtolower($this->header('X-Forwarded-Proto')) === 'https';
    }

    public function isApi(): bool
    {
        // the passkey endpoints of the login are JSON as well
        return str_starts_with($this->path, '/api/') || str_starts_with($this->path, '/login/passkey/');
    }

    public function userAgent(): string
    {
        return substr((string) ($this->server['HTTP_USER_AGENT'] ?? ''), 0, 255);
    }

    public function q(string $key, string $default = ''): string
    {
        $v = $this->query[$key] ?? $default;
        return is_string($v) ? $v : $default;
    }

    public function post(string $key, string $default = ''): string
    {
        $v = $this->post[$key] ?? $default;
        return is_string($v) ? $v : $default;
    }

    /** @return array<string,mixed> */
    public function json(): array
    {
        if ($this->json === null) {
            $raw = file_get_contents('php://input', false, null, 0, 2 * 1024 * 1024) ?: '';
            if ($raw === '') {
                $this->json = [];
            } else {
                $d = json_decode($raw, true);
                if (!is_array($d)) {
                    throw new HttpException(400, 'Invalid JSON');
                }
                $this->json = $d;
            }
        }
        return $this->json;
    }
}
