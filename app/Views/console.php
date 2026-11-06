<?php
/**
 * @var int $siteId
 * @var string $siteName
 * @var string $csrf
 * @var bool $dist whether the console build exists (public/assets/console/console.js)
 */
?><!doctype html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <meta name="csrf" content="<?= e($csrf) ?>">
    <title>Console · <?= e($siteName) ?></title>
<?php if ($dist): ?>
    <link rel="stylesheet" href="<?= asset('console/console.css') ?>">
<?php endif; ?>
</head>
<body data-site="<?= (int) $siteId ?>">
<?php if ($dist): ?>
<header class="bar">
    <span id="status" role="status" aria-live="polite">Not connected</span>
    <span class="spacer"></span>
    <button id="connect" type="button">Connect</button>
    <button id="disconnect" type="button" hidden>Disconnect</button>
</header>
<form id="reauth" hidden autocomplete="off">
    <p>Opening a shell needs your password again (and the code of your authenticator app if you have one). The confirmation is valid for 10 minutes.</p>
    <label>Password<input id="re-pass" type="password" autocomplete="current-password" required></label>
    <label id="re-code-wrap" hidden>Authenticator code<input id="re-code" inputmode="numeric" autocomplete="one-time-code" maxlength="12"></label>
    <button type="submit">Confirm</button>
    <span id="re-msg" role="alert"></span>
</form>
<div id="term" aria-label="Terminal of <?= e($siteName) ?>"></div>
<script type="module" src="<?= asset('console/console.js') ?>"></script>
<?php else: ?>
<main style="font-family:system-ui;padding:2rem;max-width:40rem;margin:auto">
    <h1>Console not built</h1>
    <p>The files in <code>public/assets/console/</code> are missing. In the Docker image they are created during the build; locally run <code>cd frontend &amp;&amp; npm ci &amp;&amp; npm run build</code>.</p>
</main>
<?php endif; ?>
</body>
</html>
