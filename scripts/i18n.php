<?php
declare(strict_types=1);

/**
 * Translation helper. The English texts in frontend/src are the keys; a language file lang/<code>.json maps them to the translation.
 *
 *   php scripts/i18n.php list                list the texts found in the interface
 *   php scripts/i18n.php missing de          texts without a translation in lang/de.json (and entries that are no longer used)
 *   php scripts/i18n.php init fr "Français" fr-FR   create lang/fr.json with every text (translation = empty)
 *   php scripts/i18n.php sync de             add missing texts (empty) and remove unused ones
 *   php scripts/i18n.php check               validate all lang/*.json (placeholders, format); exit code 1 on problems
 *
 * Found: JSX text, attributes (placeholder, title, aria-label, label, hint, alt) and the first argument of fill(), toast(), askConfirm().
 */

$root = dirname(__DIR__);

/** @return list<string> */
function extract_texts(string $root): array
{
    $found = [];
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/frontend/src', FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        $name = $f->getFilename();
        if (!preg_match('/\.tsx?$/', $name) || str_contains($name, '.test.') || str_contains($f->getPathname(), '/console/')) {
            continue;
        }
        $src = (string) file_get_contents($f->getPathname());
        // JSX text between tags; expressions, code and attributes inside the tag are not text
        if (preg_match_all('/>([^<>{}=;()`]*[A-Za-z][^<>{}=;`]*)</', $src, $m)) {
            foreach ($m[1] as $t) {
                $found[] = $t;
            }
        }
        // string literals inside {' … '} used as JSX text
        if (preg_match_all('/\{\s*(\'(?:[^\'\\\\\n]|\\\\.)*\'|"(?:[^"\\\\\n]|\\\\.)*")\s*\}/', $src, $m)) {
            foreach ($m[1] as $t) {
                $found[] = stripcslashes(substr($t, 1, -1));
            }
        }
        if (preg_match_all('/\b(?:placeholder|title|aria-label|label|hint|alt|message)=(?:"([^"{}]+)"|\{\s*\'((?:[^\'\\\\\n]|\\\\.)*)\'\s*\})/', $src, $m, PREG_SET_ORDER)) {
            foreach ($m as $x) {
                $found[] = stripcslashes($x[1] !== '' ? $x[1] : $x[2]);
            }
        }
        if (preg_match_all('/\b(?:fill|toast|askConfirm|setError|t)\(\s*(?:\'((?:[^\'\\\\\n]|\\\\.)*)\'|"((?:[^"\\\\\n]|\\\\.)*)")/', $src, $m, PREG_SET_ORDER)) {
            foreach ($m as $x) {
                $found[] = stripcslashes($x[1] !== '' ? $x[1] : ($x[2] ?? ''));
            }
        }
        // sentences inside expressions (conditions, template parts): 'The certificate has expired! '
        if (preg_match_all('/(?<![\\w.\/-])(?:\'([A-Z][^\'\n]{9,}[.!?:])\s?\'|"([A-Z][^"\n]{9,}[.!?:])\s?")/', $src, $m, PREG_SET_ORDER)) {
            foreach ($m as $x) {
                $found[] = stripcslashes($x[1] !== '' ? $x[1] : $x[2]);
            }
        }
        // <Rich text="… {name} …" with={{ … }} />: a whole sentence with inline elements (the placeholders are part of the key)
        if (preg_match_all('/<Rich\s+text="([^"]+)"/', $src, $m)) {
            foreach ($m[1] as $t) {
                $found[] = html_entity_decode($t);
            }
        }
        // object values that are sentences or phrases of several words: { zip: 'Compress to ZIP' }
        if (preg_match_all('/\b[a-zA-Z_]\w*:\s*\'([A-Z][^\'\n]*\s[^\'\n]*)\'\s*[,}]/', $src, $m)) {
            foreach ($m[1] as $t) {
                $found[] = stripcslashes($t);
            }
        }
        // data tables in .ts files: { label: 'Overview' }, { title: '…' }
        if (preg_match_all('/\b(?:label|title|text|hint)\s*:\s*(?:\'((?:[^\'\\\\\n]|\\\\.)*)\'|"([^"\n]*)")/', $src, $m, PREG_SET_ORDER)) {
            foreach ($m as $x) {
                $found[] = stripcslashes($x[1] !== '' ? $x[1] : ($x[2] ?? ''));
            }
        }
        // second and third argument of askConfirm('title', 'text', 'Ok')
        if (preg_match_all('/askConfirm\(\s*(?:\'(?:[^\'\\\\\n]|\\\\.)*\'|"[^"\n]*")\s*,\s*(?:\'((?:[^\'\\\\\n]|\\\\.)*)\'|"([^"\n]*)")(?:\s*,\s*(?:\'((?:[^\'\\\\\n]|\\\\.)*)\'|"([^"\n]*)"))?/', $src, $m, PREG_SET_ORDER)) {
            foreach ($m as $x) {
                foreach ([1, 2, 3, 4] as $i) {
                    if (($x[$i] ?? '') !== '') {
                        $found[] = stripcslashes($x[$i]);
                    }
                }
            }
        }
    }
    $out = [];
    foreach ($found as $t) {
        $t = trim(preg_replace('/\s+/', ' ', $t) ?? '');
        // text that is only symbols, a code identifier or a path is not translated
        if ($t === '' || !preg_match('/[A-Za-z]{2}/', $t) || preg_match('~^[\w./:#@-]+$~', $t) && !preg_match('/^[A-Z][a-z]+$/', $t)) {
            continue;
        }
        // fragments of source code that the patterns above caught by accident (e.g. the ", dir: " between the parts of a Rich element)
        if (preg_match('~^[,\s]*\w+:\s*$~', $t)) {
            continue;
        }
        if (preg_match('~\b(await|Promise|readonly|Record|RANK|c\.risk)\b|\bnew [A-Z]|=>|^[!:]\s|[a-z]\.[a-z]+\(|\)\)\s*$|^\)\s*&&~', $t) || preg_match('~\?\s*\(\s*$~', $t)) {
            continue;
        }
        $out[$t] = true;
    }
    $keys = array_keys($out);
    sort($keys, SORT_STRING);
    return $keys;
}

/** @return array{meta:array<string,string>,strings:array<string,string>} */
function read_lang(string $file): array
{
    $j = json_decode((string) file_get_contents($file), true, 8, JSON_THROW_ON_ERROR);
    return ['meta' => (array) ($j['_meta'] ?? []), 'strings' => (array) ($j['strings'] ?? [])];
}

/** @param array<string,string> $meta @param array<string,string> $strings */
function write_lang(string $file, array $meta, array $strings): void
{
    ksort($strings, SORT_STRING);
    file_put_contents($file, json_encode(['_meta' => $meta, 'strings' => $strings], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n");
}

/** @return list<string> placeholders like {name}, sorted */
function placeholders(string $s): array
{
    preg_match_all('/\{(\w+)\}/', $s, $m);
    $p = array_values(array_unique($m[1]));
    sort($p);
    return $p;
}

/** @return list<string> problems of a language file */
function check_file(string $file): array
{
    $problems = [];
    try {
        $l = read_lang($file);
    } catch (\Throwable $e) {
        return ["not valid JSON: {$e->getMessage()}"];
    }
    if (!preg_match('/^[a-z]{2,3}(-[A-Z]{2})?$/', basename($file, '.json'))) {
        $problems[] = 'the file name must be a language code such as de or pt-BR';
    }
    foreach (['name', 'locale'] as $k) {
        if (!isset($l['meta'][$k]) || trim((string) $l['meta'][$k]) === '') {
            $problems[] = "_meta.$k is missing";
        }
    }
    if (isset($l['meta']['locale']) && !preg_match('/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/', (string) $l['meta']['locale'])) {
        $problems[] = '_meta.locale must be a BCP 47 tag such as de-DE';
    }
    foreach ($l['strings'] as $k => $v) {
        if (!is_string($v)) {
            $problems[] = "“$k”: the translation must be text";
        } elseif ($v !== '' && placeholders((string) $k) !== placeholders($v)) {
            $problems[] = "“$k”: placeholders differ from the English text";
        }
    }
    return $problems;
}

$cmd = $argv[1] ?? '';
$texts = $cmd === '' || $cmd === 'check' ? [] : extract_texts($root);
$langFile = static fn (string $c): string => $root . '/lang/' . $c . '.json';

switch ($cmd) {
    case 'list':
        echo implode("\n", $texts) . "\n";
        fwrite(STDERR, count($texts) . " texts\n");
        break;
    case 'missing':
    case 'sync':
        $code = $argv[2] ?? '';
        if (!is_file($langFile($code))) {
            fwrite(STDERR, "lang/$code.json does not exist (php scripts/i18n.php init $code \"Name\" locale)\n");
            exit(2);
        }
        $l = read_lang($langFile($code));
        $missing = array_values(array_filter($texts, static fn (string $t): bool => ($l['strings'][$t] ?? '') === ''));
        $unused = array_values(array_diff(array_keys($l['strings']), $texts));
        if ($cmd === 'missing') {
            echo "== not translated (" . count($missing) . ")\n" . implode("\n", $missing) . "\n== no longer used (" . count($unused) . ")\n" . implode("\n", $unused) . "\n";
            break;
        }
        $new = [];
        foreach ($texts as $t) {
            $new[$t] = $l['strings'][$t] ?? '';
        }
        write_lang($langFile($code), $l['meta'], $new);
        echo 'lang/' . $code . '.json: ' . count($missing) . ' added, ' . count($unused) . " removed\n";
        break;
    case 'init':
        [$code, $name, $loc] = [$argv[2] ?? '', $argv[3] ?? '', $argv[4] ?? ''];
        if ($code === '' || $name === '' || $loc === '' || is_file($langFile($code))) {
            fwrite(STDERR, "usage: php scripts/i18n.php init <code> \"<Name>\" <locale>   (the file must not exist yet)\n");
            exit(2);
        }
        write_lang($langFile($code), ['name' => $name, 'locale' => $loc], array_fill_keys($texts, ''));
        $p = check_file($langFile($code));
        echo "lang/$code.json created with " . count($texts) . " texts\n";
        exit($p ? 1 : 0);
    case 'check':
        $bad = 0;
        foreach (glob($root . '/lang/*.json') ?: [] as $f) {
            $p = check_file($f);
            echo ($p ? 'FAIL ' : 'ok   ') . 'lang/' . basename($f) . "\n";
            foreach ($p as $x) {
                echo "     $x\n";
            }
            $bad += count($p);
        }
        exit($bad > 0 ? 1 : 0);
    default:
        fwrite(STDERR, "usage: php scripts/i18n.php list|missing <code>|sync <code>|init <code> \"<Name>\" <locale>|check\n");
        exit(2);
}
