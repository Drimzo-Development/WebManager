<?php
// Favicon and, when an accent colour is set, the stylesheet that derives the brand shades from it.
$logo = \WebManager\Support\Brand::logoUrl();
$theme = \WebManager\Support\Brand::themeUrl();
?>
    <link rel="icon" href="<?= e($logo) ?>">
<?php if ($theme !== null): ?>
    <link rel="stylesheet" href="<?= e($theme) ?>">
<?php endif; ?>
