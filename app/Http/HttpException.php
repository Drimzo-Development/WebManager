<?php
declare(strict_types=1);

namespace WebManager\Http;

final class HttpException extends \RuntimeException
{
    /** @param array<string,mixed> $extra */
    public function __construct(public readonly int $status, string $message, public readonly array $extra = [])
    {
        parent::__construct($message, $status);
    }
}
