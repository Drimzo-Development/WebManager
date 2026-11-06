<?php
declare(strict_types=1);

namespace WebManager\Support;

/**
 * Appearance of the dashboard: name, logo and accent colour can be changed (white label). The product name
 * "webmanager" is fixed and always shown (login page, sidebar, pages of protected websites), see PRODUCT.
 */
final class Brand
{
    /** Product name that stays visible no matter how the dashboard is customised. */
    public const PRODUCT = 'webmanager';
    public const DEFAULT_NAME = 'Drimzo Development';
    /** Author credit ("made with love by ..."). Fixed on purpose, see NOTICE.md. */
    public const AUTHOR = 'Drimzo Development';
    public const AUTHOR_URL = 'https://github.com/Drimzo-Development';
    public const MAX_LOGO_BYTES = 524288;

    /** @var array{name:string,color:string,logo:?string}|null */
    private static ?array $cache = null;

    // ---- stored values -----------------------------------------------------------------------------------------

    /** @return array{name:string,color:string,logo:?string} logo = etag of the stored logo or null */
    public static function load(): array
    {
        if (self::$cache !== null) {
            return self::$cache;
        }
        $out = ['name' => self::DEFAULT_NAME, 'color' => '', 'logo' => null];
        try {
            foreach (Db::all("SELECT k, v FROM settings WHERE k IN ('brand_name','brand_color')") as $r) {
                if ($r['k'] === 'brand_name' && self::validName($r['v']) === null) {
                    $out['name'] = trim($r['v']);
                }
                if ($r['k'] === 'brand_color' && self::validColor($r['v']) === null) {
                    $out['color'] = strtolower($r['v']);
                }
            }
            $etag = Db::val("SELECT etag FROM brand_assets WHERE k = 'logo'");
            $out['logo'] = is_string($etag) ? $etag : null;
        } catch (\Throwable) {
            // before the migration or without a database the defaults apply
        }
        return self::$cache = $out;
    }

    /** "made with ♥ by Drimzo Development" as HTML (the name links to the author's GitHub profile). */
    public static function credit(): string
    {
        return 'made with <span class="heart" aria-label="Liebe">♥</span> by <a href="' . self::AUTHOR_URL
            . '" target="_blank" rel="noopener noreferrer">' . self::AUTHOR . '</a>';
    }

    public static function reset(): void
    {
        self::$cache = null;
    }

    public static function name(): string
    {
        return self::load()['name'];
    }

    public static function logoUrl(): string
    {
        $l = self::load()['logo'];
        return $l !== null ? '/brand/logo?v=' . rawurlencode($l) : '/assets/logo.png';
    }

    public static function hasLogo(): bool
    {
        return self::load()['logo'] !== null;
    }

    /** URL of the colour stylesheet, or null when the default colours are used. */
    public static function themeUrl(): ?string
    {
        $c = self::load()['color'];
        return $c !== '' ? '/brand/theme.css?v=' . substr(sha1($c), 0, 10) : null;
    }

    // ---- validation (pure) -------------------------------------------------------------------------------------

    /** @return string|null error message, null when valid */
    public static function validName(mixed $name): ?string
    {
        if (!is_string($name)) {
            return 'Please enter a name.';
        }
        $n = trim($name);
        $len = mb_strlen($n);
        if ($len < 1 || $len > 40) {
            return 'The name must be 1 to 40 characters long.';
        }
        if (preg_match('/[\p{C}<>]/u', $n)) {
            return 'The name must not contain control characters or angle brackets.';
        }
        return null;
    }

    /** @return string|null error message; empty string = default colours */
    public static function validColor(mixed $color): ?string
    {
        if ($color === '' || $color === null) {
            return null;
        }
        if (!is_string($color) || !preg_match('/^#[0-9a-fA-F]{6}$/', $color)) {
            return 'The color must be given as #RRGGBB, e.g. #5b8def.';
        }
        if (self::contrastWithWhite($color) < 4.5) {
            return 'This color is too light for white text on buttons. Please choose a darker one.';
        }
        return null;
    }

    /** WCAG contrast ratio of the colour against white. */
    public static function contrastWithWhite(string $hex): float
    {
        $c = [hexdec(substr($hex, 1, 2)), hexdec(substr($hex, 3, 2)), hexdec(substr($hex, 5, 2))];
        $lin = array_map(static function (int|float $v): float {
            $v /= 255;
            return $v <= 0.03928 ? $v / 12.92 : (($v + 0.055) / 1.055) ** 2.4;
        }, $c);
        $l = 0.2126 * $lin[0] + 0.7152 * $lin[1] + 0.0722 * $lin[2];
        return 1.05 / ($l + 0.05);
    }

    /** Stylesheet that derives the brand shades from the chosen accent colour. */
    public static function css(string $color): string
    {
        if (self::validColor($color) !== null || $color === '') {
            return '';
        }
        $c = strtolower($color);
        return ":root{--brand-600:$c;--brand-500:color-mix(in oklab,$c 88%,#fff);--brand-700:color-mix(in oklab,$c 82%,#000);"
            . "--brand-800:color-mix(in oklab,$c 66%,#000);--brand-400:color-mix(in oklab,$c 72%,#fff);--brand-300:color-mix(in oklab,$c 50%,#fff)}\n"
            . ":root[data-theme=\"light\"]{--brand-300:$c;--brand-400:$c}\n";
    }

    /**
     * Checks an uploaded logo.
     *
     * @return array{mime:string}|string the MIME type to serve, or an error message
     */
    public static function checkLogo(string $data): array|string
    {
        if ($data === '' || strlen($data) > self::MAX_LOGO_BYTES) {
            return 'The logo may be at most 512 KB.';
        }
        $info = @getimagesizefromstring($data);
        $types = [IMAGETYPE_PNG => 'image/png', IMAGETYPE_JPEG => 'image/jpeg', IMAGETYPE_WEBP => 'image/webp'];
        if ($info !== false && isset($types[$info[2]])) {
            return $info[0] > 4000 || $info[1] > 4000 ? 'The logo may be at most 4000 × 4000 pixels.' : ['mime' => $types[$info[2]]];
        }
        if (self::looksLikeSvg($data)) {
            return self::svgError($data) ?? ['mime' => 'image/svg+xml'];
        }
        return 'PNG, JPEG, WebP and SVG are allowed.';
    }

    private static function looksLikeSvg(string $d): bool
    {
        return (bool) preg_match('/^\s*(<\?xml[^>]*\?>\s*)?(<!--.*?-->\s*)*(<!DOCTYPE\s+svg[^>\[]*>\s*)?(<!--.*?-->\s*)*<svg[\s>]/is', substr($d, 0, 2000));
    }

    /** SVG logos are only ever shown through <img> and served with a sandboxing CSP; scripts and external content are refused as well. */
    private static function svgError(string $d): ?string
    {
        if (!mb_check_encoding($d, 'UTF-8')) {
            return 'The SVG file must be UTF-8 encoded.';
        }
        if (preg_match('/<\s*(script|foreignObject|iframe|object|embed|audio|video|link|meta|image\b[^>]*href\s*=\s*["\']\s*https?:)|\bon[a-z]+\s*=|javascript\s*:|<!ENTITY|<!DOCTYPE[^>]*\[|\bhref\s*=\s*["\']\s*(https?:|data:text|\/\/)|@import|url\(\s*["\']?\s*https?:/i', $d)) {
            return 'The SVG file contains scripts or external content and is rejected for security reasons.';
        }
        return null;
    }
}
