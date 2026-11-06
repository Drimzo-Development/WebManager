<?php
declare(strict_types=1);

namespace WebManager\Support;

/**
 * Text exposition format of Prometheus / OpenMetrics-compatible scrapers (version 0.0.4). Pure formatting: the collection of the
 * values lives in MetricsApi, so this class can be tested without a database.
 */
final class Metrics
{
    public const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

    /** @var array<string,array{type:string,help:string,samples:list<array{array<string,string>,float|int}>}> */
    private array $families = [];

    public function add(string $name, string $type, string $help, array $labels, float|int|null $value): void
    {
        if ($value === null || (is_float($value) && !is_finite($value))) {
            return; // an unknown value is left out, never reported as 0
        }
        $this->families[$name] ??= ['type' => $type, 'help' => $help, 'samples' => []];
        $this->families[$name]['samples'][] = [$labels, $value];
    }

    public static function escapeLabel(string $v): string
    {
        return str_replace(['\\', "\n", '"'], ['\\\\', '\\n', '\\"'], $v);
    }

    public static function escapeHelp(string $v): string
    {
        return str_replace(['\\', "\n"], ['\\\\', '\\n'], $v);
    }

    private static function number(float|int $v): string
    {
        return is_int($v) ? (string) $v : rtrim(rtrim(sprintf('%.6F', $v), '0'), '.');
    }

    public function render(): string
    {
        $out = '';
        foreach ($this->families as $name => $f) {
            $out .= '# HELP ' . $name . ' ' . self::escapeHelp($f['help']) . "\n# TYPE " . $name . ' ' . $f['type'] . "\n";
            foreach ($f['samples'] as [$labels, $value]) {
                $pairs = [];
                foreach ($labels as $k => $v) {
                    $pairs[] = $k . '="' . self::escapeLabel((string) $v) . '"';
                }
                $out .= $name . ($pairs ? '{' . implode(',', $pairs) . '}' : '') . ' ' . self::number($value) . "\n";
            }
        }
        return $out;
    }
}
