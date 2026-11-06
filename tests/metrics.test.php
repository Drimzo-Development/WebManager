<?php
declare(strict_types=1);

// php tests/metrics.test.php   (no database: text format of the metrics endpoint and its permission)
require dirname(__DIR__) . '/app/bootstrap.php';

use WebManager\Http\Permissions;
use WebManager\Support\Metrics;

$fails = 0;
function check(string $name, bool $ok): void
{
    global $fails;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    $fails += $ok ? 0 : 1;
}

$m = new Metrics();
$m->add('wm_up', 'gauge', 'Is up.', ['site' => 'site-001', 'name' => 'My "shop"\\a' . "\n" . 'b'], 1);
$m->add('wm_ratio', 'gauge', 'Ratio.', [], 0.5);
$m->add('wm_up', 'gauge', 'Is up.', ['site' => 'site-002', 'name' => 'x'], 0);
$m->add('wm_missing', 'gauge', 'Unknown.', [], null);
$m->add('wm_nan', 'gauge', 'Not a number.', [], NAN);
$m->add('wm_big', 'counter', 'Big.', [], 12345678901);
$m->add('wm_small', 'gauge', 'Small.', [], 0.0001234567);
$out = $m->render();

check('HELP and TYPE once per family, samples together', substr_count($out, '# TYPE wm_up gauge') === 1
    && preg_match('/wm_up\{[^\n]*\n[^\n]*wm_up\{/', $out) === 1);
check('label values are escaped', str_contains($out, 'name="My \\"shop\\"\\\\a\\nb"'));
check('every sample is on one line', !preg_match('/\n[^#wm]/', $out) && substr($out, -1) === "\n");
check('unknown values are left out', !str_contains($out, 'wm_missing') && !str_contains($out, 'wm_nan'));
check('number formats', str_contains($out, "wm_ratio 0.5\n") && str_contains($out, "wm_big 12345678901\n") && str_contains($out, "wm_small 0.000123\n"));
check('sample without labels has no braces', str_contains($out, "wm_ratio 0.5\n") && !str_contains($out, 'wm_ratio{'));
check('content type is the text format', str_starts_with(Metrics::CONTENT_TYPE, 'text/plain; version=0.0.4'));
check('a viewer may read the metrics', Permissions::required('GET', '/api/v1/metrics') === 'viewer');
check('other methods need an operator', Permissions::required('POST', '/api/v1/metrics') === 'operator');

exit($fails > 0 ? 1 : 0);
