'use strict';
// Generates the static fallback pages of the reverse proxy into docker/proxy/errors (committed; run after editing the texts):
//   node scripts/build-error-pages.js
// The pages are served by nginx itself, so they still appear when the dashboard, the agent or a website is down.
// They load only same-origin files (style, logo) and use no scripts, so strict Content-Security-Policy headers cannot break them.
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'docker', 'proxy', 'errors');
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'public', 'assets', 'logo.png'), path.join(OUT, 'assets', 'logo.png'));

// kind: warn = website not reachable/overloaded, err = error on the server, info = request was rejected
const PAGES = [
  { code: 502, kind: 'warn', retry: true, title: 'This website is currently offline',
    text: 'The server of the website does not answer. It was stopped, is restarting or has an error. This is usually only temporary.',
    hints: ['The page reloads automatically as soon as the website is reachable again.', 'Do you run this website? Check its status and logs in the WebManager.'] },
  { code: 503, kind: 'warn', retry: true, title: 'Temporarily unavailable',
    text: 'The website cannot process your request right now, for example because of maintenance or high load.',
    hints: ['Please try again in a few minutes.', 'The page reloads automatically.'] },
  { code: 504, kind: 'warn', retry: true, title: 'The website answers too slowly',
    text: 'The server of the website did not answer in time. It is probably heavily loaded or the request takes unusually long.',
    hints: ['The page reloads automatically.', 'If the error keeps happening, please inform the operator of the website.'] },
  { code: 500, kind: 'err', retry: false, title: 'Internal server error',
    text: 'An unexpected error occurred while processing your request.',
    hints: ['Please reload the page in a few minutes.', 'If the problem persists, please inform the operator of the website.'] },
  { code: 400, kind: 'info', retry: false, title: 'Invalid request',
    text: 'The server could not understand your request. This can be caused by a malformed address or damaged cookies.',
    hints: ['Check the address in the address bar.', 'If necessary, delete the cookies of this website and try again.'] },
  { code: 404, kind: 'info', retry: false, title: 'Page not found',
    text: 'The page you are looking for does not exist or has been moved.',
    hints: ['Check the address in the address bar for typing errors.', 'Use the link below to go back to the start page.'] },
  { code: 403, kind: 'info', retry: false, title: 'Access denied',
    text: 'You are not allowed to open this page. Access may be restricted for your address or country.',
    hints: ['If you think this is a mistake, please contact the operator of the website.'] },
  { code: 413, kind: 'info', retry: false, title: 'The file is too large',
    text: 'Your request or the upload exceeds the allowed size.',
    hints: ['Choose a smaller file or reduce its size, for example by compressing it.'] },
  { code: 429, kind: 'info', retry: false, title: 'Too many requests',
    text: 'Too many requests came from your address in a short time. To protect the website, further requests are temporarily rejected.',
    hints: ['Please wait a moment and then reload the page.'] },
];

const ICON = {
  warn: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  err: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
};

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `:root { color-scheme: light dark; --bg: #f3f5f8; --card: #fff; --fg: #1a2230; --muted: #6b7686; --line: #dfe3ea; --brand: #2f6fe4; --warn: #a86a00; --warn-bg: rgba(200, 130, 0, .13); --err: #c8332b; --err-bg: rgba(200, 51, 43, .10); --info: #2f6fe4; --info-bg: rgba(47, 111, 228, .10); }
@media (prefers-color-scheme: dark) { :root { --bg: #14171c; --card: #1c2027; --fg: #e4e8ee; --muted: #818a99; --line: #2d343e; --brand: #5b8def; --warn: #e0a23c; --warn-bg: rgba(224, 162, 60, .15); --err: #e5534b; --err-bg: rgba(229, 83, 75, .15); --info: #5b8def; --info-bg: rgba(91, 141, 239, .14); } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.25rem; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.card { width: min(34rem, 100%); background: var(--card); border: 1px solid var(--line); border-top: 4px solid var(--c); border-radius: 8px; padding: 2rem 2rem 1.5rem; box-shadow: 0 1px 2px rgba(20, 30, 50, .12); }
.warn { --c: var(--warn); --c-bg: var(--warn-bg); } .err { --c: var(--err); --c-bg: var(--err-bg); } .info { --c: var(--info); --c-bg: var(--info-bg); }
.brand { display: flex; align-items: center; gap: .75rem; margin-bottom: 1.5rem; }
.brand img { display: block; width: 3rem; height: 3rem; object-fit: contain; }
.brand span { font-size: 1.15rem; font-weight: 600; letter-spacing: -.01em; }
.top { display: flex; align-items: center; gap: .9rem; margin-bottom: 1.25rem; }
.icon { display: grid; place-items: center; width: 3.4rem; height: 3.4rem; border-radius: 50%; background: var(--c-bg); color: var(--c); flex: none; }
.code { margin: 0; font-size: .8rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--c); }
h1 { margin: .1rem 0 0; font-size: 1.45rem; line-height: 1.25; }
p { margin: 0 0 1rem; color: var(--muted); }
ul { margin: 0 0 1.25rem; padding-left: 1.2rem; color: var(--muted); }
li { margin-bottom: .35rem; }
.actions { display: flex; gap: .6rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
.btn { display: inline-block; padding: .6rem 1.1rem; border-radius: 5px; background: var(--brand); color: #fff; font-weight: 600; text-decoration: none; }
.btn:hover { filter: brightness(1.1); }
.btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.foot { border-top: 1px solid var(--line); padding-top: 1rem; font-size: .8rem; color: var(--muted); }
.foot p { margin: 0; font-size: inherit; }
.foot a { color: inherit; }
.heart { color: #e5484d; }
`;
fs.writeFileSync(path.join(OUT, 'assets', 'style.css'), CSS);

for (const p of PAGES) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${p.retry ? '<meta http-equiv="refresh" content="20">\n' : ''}<title>${p.code} – ${esc(p.title)}</title>
<link rel="stylesheet" href="/__wm_err/assets/style.css">
<link rel="icon" href="/__wm_err/assets/logo.png">
</head>
<body>
<main class="card ${p.kind}">
<div class="brand"><img src="/__wm_err/assets/logo.png" alt="" width="48" height="48"><span>webmanager</span></div>
<div class="top"><span class="icon">${ICON[p.kind]}</span><div><p class="code" style="margin:0">Error ${p.code}</p><h1>${esc(p.title)}</h1></div></div>
<p>${esc(p.text)}</p>
<ul>${p.hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
<div class="actions"><a class="btn" href="/">Back to the start page</a></div>
<div class="foot"><p>powered by webmanager · made with <span class="heart">♥</span> by <a href="https://github.com/Drimzo-Development" target="_blank" rel="noopener noreferrer">Drimzo Development</a></p></div>
</main>
</body>
</html>
`;
  fs.writeFileSync(path.join(OUT, `${p.code}.html`), html);
}
console.log(`${PAGES.length} pages written to ${OUT}`);
