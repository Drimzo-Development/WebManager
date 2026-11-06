<?php
/** @var string $title */
/** @var string $message */
/** @var bool $logo */
$heading = $title !== '' ? $title : 'We will be right back';
$intro = $message !== '' ? $message : 'This website is being maintained. Please try again in a few minutes.';
?><!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title><?= e($heading) ?></title>
    <link rel="stylesheet" href="/__wm_gate/gate.css">
    <link rel="icon" href="<?= $logo ? '/__wm_gate/brand-logo' : '/__wm_gate/logo.png' ?>">
</head>
<body>
<main class="card center">
    <img class="logo" src="<?= $logo ? '/__wm_gate/brand-logo' : '/__wm_gate/logo.png' ?>" alt="" width="64" height="64">
    <h1><?= e($heading) ?></h1>
    <p><?= nl2br(e($intro)) ?></p>
    <p class="foot">powered by webmanager · <?= \WebManager\Support\Brand::credit() ?></p>
</main>
</body>
</html>
