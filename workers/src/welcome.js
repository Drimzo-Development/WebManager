'use strict';
/* Default pages written into a freshly created static / PHP website. */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const phpSingleQuoted = (s) => String(s).split('\\').join('\\\\').split("'").join("\\'");

const CSS = `
:root{color-scheme:light dark;--bg:#f4f7fc;--card:#fff;--text:#0f1a2e;--muted:#5a6f95;--line:#e6ecf6;--brand:#0a63d8;--chip:#eaf3ff}
@media (prefers-color-scheme:dark){:root{--bg:#070d1b;--card:#0e182c;--text:#e8effc;--muted:#9db2da;--line:#16243f;--brand:#3f8cf5;--chip:#16243f}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.55}
main{width:min(100%,38rem);background:var(--card);border:1px solid var(--line);border-radius:14px;padding:2.25rem 2rem;box-shadow:0 10px 30px -14px rgba(10,30,70,.25)}
.mark{width:3rem;height:3rem;margin-bottom:1.25rem}
.eyebrow{margin:0 0 .35rem;color:var(--brand);font-size:.75rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
h1{margin:0 0 .6rem;font-size:1.75rem;font-weight:650;letter-spacing:-.01em;word-break:break-word}
p{margin:0;color:var(--muted)}
ol{margin:1.4rem 0 0;padding:0;list-style:none;display:grid;gap:.6rem}
li{display:flex;gap:.75rem;align-items:flex-start;color:var(--text);font-size:.95rem}
li b{flex:none;display:grid;place-items:center;width:1.5rem;height:1.5rem;border-radius:50%;background:var(--chip);color:var(--brand);font-size:.8rem}
code{background:var(--chip);padding:.1em .4em;border-radius:5px;font-size:.88em}
footer{margin-top:1.75rem;padding-top:1rem;border-top:1px solid var(--line);font-size:.8rem;color:var(--muted);display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}
`.replace(/\n/g, '');

const MARK = '<svg class="mark" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1a73ec"/><stop offset="1" stop-color="#0b3f8a"/></linearGradient></defs><rect width="48" height="48" rx="11" fill="url(#g)"/><path d="M16 11h9.5c5 0 8 2.6 8 6.6 0 2.5-1.3 4.4-3.5 5.3 2.9.8 4.7 3 4.7 6 0 4.3-3.4 7.1-8.8 7.1H16z" fill="#fff"/><path d="M21 15.5v6h3.6c2 0 3.1-1 3.1-3s-1.1-3-3.1-3zm0 10.5v6.5h4.2c2.3 0 3.6-1.2 3.6-3.3S27.5 26 25.2 26z" fill="#1a4fa8"/></svg>';

function body(name, extra) {
  return `<h1>${name}</h1>
    <p>This website is running and waiting for your content.${extra ? ` ${extra}` : ''}</p>
    <ol>
      <li><b>1</b><span>Upload files: edit them in the WebManager under <code>Files</code> or deploy via Git/ZIP under <code>Commands &rarr; Load code</code>.</span></li>
      <li><b>2</b><span>Add a domain and point its DNS to this server (<code>Domains &amp; HTTPS</code>).</span></li>
      <li><b>3</b><span>Set up HTTPS &ndash; only then is the site reachable over an encrypted connection.</span></li>
    </ol>`;
}

function page(name, inner, withMark = true) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${name}</title>
<style>${CSS}</style>
</head>
<body>
  <main>
    ${withMark ? MARK : ''}
    <p class="eyebrow">New website</p>
    ${inner}
    <footer><span>Made with webmanager</span><span>Replace this file in the file manager.</span></footer>
  </main>
</body>
</html>
`;
}

/** Static site: plain HTML, name escaped for HTML. */
const welcomeHtml = (name) => page(esc(name), body(esc(name), ''));

/** PHP site: same page, rendered by PHP so it can show the running PHP version. The name is escaped for PHP and HTML. */
const welcomePhp = (name) => `<?php
$name = htmlspecialchars('${phpSingleQuoted(name)}', ENT_QUOTES, 'UTF-8');
$php = htmlspecialchars(PHP_VERSION, ENT_QUOTES, 'UTF-8');
?>${page('<?= $name ?>', body('<?= $name ?>', 'PHP <?= $php ?> is active.'))}`;

module.exports = { welcomeHtml, welcomePhp };
