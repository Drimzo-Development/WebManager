<?php
/** @var bool $dist whether the frontend build exists (public/assets/app/app.js) */
?><!doctype html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <meta name="color-scheme" content="dark light">
    <script src="<?= asset('theme.js') ?>"></script>
    <title><?= e(\WebManager\Support\Brand::name()) ?> · <?= e(\WebManager\Support\Brand::PRODUCT) ?></title>
<?php if ($dist): ?>
    <link rel="stylesheet" href="<?= asset('app/app.css') ?>">
<?php endif; ?>
<?= \WebManager\Support\View::partial('brand_head') ?></head>
<body>
<div id="root"></div>
<?php if ($dist): ?>
<script type="module" src="<?= asset('app/app.js') ?>"></script>
<?php else: ?>
<main style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto">
    <h1>Interface not built</h1>
    <p>The files in <code>public/assets/app/</code> are missing. In the Docker image they are created during the build; locally run <code>cd frontend &amp;&amp; npm ci &amp;&amp; npm run build</code>.</p>
</main>
<?php endif; ?>
</body>
</html>
