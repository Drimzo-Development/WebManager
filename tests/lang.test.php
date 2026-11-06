<?php
declare(strict_types=1);

// php tests/lang.test.php   (no database: language files of the interface and the endpoint that serves them)
require dirname(__DIR__) . '/app/bootstrap.php';

use WebManager\Controllers\LangApi;

$fails = 0;
function check(string $name, bool $ok): void
{
    global $fails;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    $fails += $ok ? 0 : 1;
}

$root = dirname(__DIR__) . '/lang';
$de = LangApi::load('de', $root);
check('de is readable with name, locale and texts', $de !== null && $de['name'] === 'Deutsch' && $de['locale'] === 'de-DE' && count($de['strings']) > 500);
check('de translates a known text', ($de['strings']['Save'] ?? '') === 'Speichern');
check('the language list contains de', in_array('de', array_column(LangApi::languages($root), 'code'), true));

foreach (['', '..', '../de', 'de/../de', 'DE', 'de.json', 'deu1', 'de-de', "de\0", '/etc/passwd', 'x'] as $bad) {
    check('refused code: ' . json_encode($bad), LangApi::load($bad, $root) === null);
}

$tmp = sys_get_temp_dir() . '/wm-lang-' . bin2hex(random_bytes(4));
mkdir($tmp);
file_put_contents("$tmp/fr.json", json_encode(['_meta' => ['name' => 'Français', 'locale' => 'fr-FR'], 'strings' => ['Save' => 'Enregistrer', 'Empty' => '', 'Bad' => 5]]));
file_put_contents("$tmp/it.json", '{ not json');
file_put_contents("$tmp/es.json", json_encode(['strings' => ['Save' => 'Guardar']]));
file_put_contents("$tmp/pt.json", json_encode(['_meta' => ['name' => 'Português', 'locale' => '<script>'], 'strings' => []]));
$fr = LangApi::load('fr', $tmp);
check('empty and non-text translations are dropped', $fr !== null && $fr['strings'] === ['Save' => 'Enregistrer']);
check('broken files, missing meta and a bad locale are not offered', LangApi::load('it', $tmp) === null && LangApi::load('es', $tmp) === null && LangApi::load('pt', $tmp) === null
    && array_column(LangApi::languages($tmp), 'code') === ['fr']);
array_map('unlink', glob("$tmp/*.json") ?: []);
rmdir($tmp);

exit($fails > 0 ? 1 : 0);
