<?php
/** @var string $error */
/** @var string $next */
/** @var string $title */
/** @var string $text */
/** @var bool $logo */
$heading = $title !== '' ? $title : 'Protected area';
$intro = $text !== '' ? $text : 'Please enter the password to open this page.';
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
<main class="card">
    <img class="logo" src="<?= $logo ? '/__wm_gate/brand-logo' : '/__wm_gate/logo.png' ?>" alt="" width="64" height="64">
    <h1><?= e($heading) ?></h1>
    <p><?= nl2br(e($intro)) ?></p>
    <?php if ($error !== ''): ?><div class="err" role="alert"><?= e($error) ?></div><?php endif; ?>
    <form method="post" action="/__wm_gate/login">
        <input type="hidden" name="next" value="<?= e($next) ?>">
        <label>Password
            <input type="password" name="password" required autofocus autocomplete="current-password">
        </label>
        <button type="submit">Open access</button>
    </form>
    <p class="foot">powered by webmanager · <?= \WebManager\Support\Brand::credit() ?></p>
</main>
</body>
</html>
