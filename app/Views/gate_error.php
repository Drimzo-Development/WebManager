<?php
/** @var int $status */
/** @var string $message */
$titles = [403 => 'Access denied', 404 => 'Not found', 405 => 'Not allowed', 429 => 'Too many requests'];
$title = $titles[$status] ?? 'Error';
?><!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title><?= e($title) ?></title>
    <link rel="stylesheet" href="/__wm_gate/gate.css">
</head>
<body>
<main class="card center">
    <h1><?= e($title) ?></h1>
    <p><?= e($message) ?></p>
    <p><a href="/">Back to the start page</a></p>
    <p class="foot">powered by webmanager · <?= \WebManager\Support\Brand::credit() ?></p>
</main>
</body>
</html>
