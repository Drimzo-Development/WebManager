<?php
/** @var int $status */
/** @var string $title */
/** @var string $message */
?><!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title><?= e($title) ?> · <?= e(\WebManager\Support\Brand::name()) ?></title>
    <link rel="stylesheet" href="/assets/gate.css">
    <?= \WebManager\Support\View::partial('brand_head') ?>
</head>
<body>
<main class="card center">
    <?= \WebManager\Support\View::partial('brand_logo') ?>
    <h1><?= (int) $status ?> · <?= e($title) ?></h1>
    <p><?= e($message) ?></p>
    <p><a href="/app">Back to the start page</a></p>
    <p class="foot"><?= \WebManager\Support\Brand::credit() ?></p>
</main>
</body>
</html>
