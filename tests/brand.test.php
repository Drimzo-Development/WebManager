<?php
declare(strict_types=1);

// php tests/brand.test.php   (no database: validation, colour stylesheet, logo checks, fallbacks)
require dirname(__DIR__) . '/app/bootstrap.php';

use WebManager\Support\Brand;

$fails = 0;
function check(string $name, bool $ok): void
{
    global $fails;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    $fails += $ok ? 0 : 1;
}

// ---- name
check('default name is the vendor', Brand::DEFAULT_NAME === 'Drimzo Development');
check('product name is fixed', Brand::PRODUCT === 'webmanager');
check('normal name', Brand::validName('Sample Hosting Ltd') === null);
check('name with umlauts and punctuation', Brand::validName('Mueller & Sons – Web') === null);
check('empty name refused', Brand::validName('') !== null && Brand::validName('   ') !== null);
check('41 characters refused, 40 accepted', Brand::validName(str_repeat('a', 41)) !== null && Brand::validName(str_repeat('ä', 40)) === null);
check('angle brackets refused', Brand::validName('<b>x</b>') !== null);
check('control characters refused', Brand::validName("a\x00b") !== null && Brand::validName("a\nb") !== null);
check('non-string refused', Brand::validName(['x']) !== null && Brand::validName(null) !== null);

// ---- colour
check('empty colour = default', Brand::validColor('') === null && Brand::validColor(null) === null);
check('dark blue accepted', Brand::validColor('#0a63d8') === null);
check('uppercase hex accepted', Brand::validColor('#0A63D8') === null);
check('short hex refused', Brand::validColor('#fff') !== null);
check('name instead of hex refused', Brand::validColor('red') !== null);
check('injection attempt refused', Brand::validColor('#000000;} body{display:none') !== null && Brand::validColor('#00000g') !== null);
check('white refused (no contrast)', Brand::validColor('#ffffff') !== null);
check('light yellow refused', Brand::validColor('#ffeb3b') !== null);
check('black accepted', Brand::validColor('#000000') === null);
check('contrast of black with white is 21', abs(Brand::contrastWithWhite('#000000') - 21.0) < 0.01);
check('contrast of white with white is 1', abs(Brand::contrastWithWhite('#ffffff') - 1.0) < 0.01);

// ---- stylesheet
$css = Brand::css('#0A63D8');
check('css sets the primary shade', str_contains($css, '--brand-600:#0a63d8'));
check('css has a light theme part', str_contains($css, ':root[data-theme="light"]{--brand-300:#0a63d8'));
check('css is empty for the default', Brand::css('') === '');
check('css is empty for invalid input', Brand::css('#fff;}') === '' && Brand::css('red') === '');
check('css contains nothing but the colour', !preg_match('/[<>@]/', $css));

// ---- logo checks
$png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHAm2xQAAAABJRU5ErkJggg==');
$r = Brand::checkLogo((string) $png);
check('png accepted', is_array($r) && $r['mime'] === 'image/png');
check('empty file refused', is_string(Brand::checkLogo('')));
check('oversized file refused', is_string(Brand::checkLogo(str_repeat('a', Brand::MAX_LOGO_BYTES + 1))));
check('text file refused', is_string(Brand::checkLogo('hello world')));
check('html refused', is_string(Brand::checkLogo('<html><body>x</body></html>')));
check('php refused', is_string(Brand::checkLogo('<?php echo 1;')));

$svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0a63d8"/></svg>';
$r = Brand::checkLogo($svg);
check('plain svg accepted', is_array($r) && $r['mime'] === 'image/svg+xml');
$r = Brand::checkLogo('<?xml version="1.0" encoding="UTF-8"?>' . "\n" . '<!-- logo -->' . "\n" . $svg);
check('svg with xml header and comment accepted', is_array($r));
check('svg with doctype accepted', is_array(Brand::checkLogo('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">' . $svg)));
foreach ([
    'script tag' => '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    'onload handler' => '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    'onclick handler' => '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick = "x()"/></svg>',
    'javascript url' => '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
    'foreignObject' => '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>x</div></foreignObject></svg>',
    'external image' => '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
    'external href' => '<svg xmlns="http://www.w3.org/2000/svg"><use href="//evil.example/x.svg#a"/></svg>',
    'entity' => '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    'css import' => '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/a.css);</style></svg>',
    'css external url' => '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.example/a)"/></svg>',
    'iframe' => '<svg xmlns="http://www.w3.org/2000/svg"><iframe src="x"></iframe></svg>',
    'script in uppercase' => '<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT>1</SCRIPT></svg>',
] as $label => $bad) {
    check("svg with $label refused", is_string(Brand::checkLogo($bad)));
}
check('svg that is not utf-8 refused', is_string(Brand::checkLogo("<svg xmlns=\"http://www.w3.org/2000/svg\"><title>\xff\xfe</title></svg>")));

// ---- defaults without a database
check('name falls back to the default without a database', Brand::name() === 'Drimzo Development');
check('logo falls back to the packaged file', Brand::logoUrl() === '/assets/logo.png' && !Brand::hasLogo());
check('no colour stylesheet by default', Brand::themeUrl() === null);

exit($fails === 0 ? 0 : 1);
