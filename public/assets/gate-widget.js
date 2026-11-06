/* "powered by webmanager" badge for password-protected websites; click shows the remaining session time. */
(function () {
  'use strict';
  if (window.__bitGateWidget) return;
  window.__bitGateWidget = true;

  var host = document.createElement('div');
  host.setAttribute('data-wm-gate', '');
  var root = host.attachShadow({ mode: 'open' });
  var css = ':host{all:initial}'
    + '.w{position:fixed;left:12px;bottom:12px;z-index:2147483647;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#14202e}'
    + '.b{display:flex;align-items:center;gap:6px;padding:6px 11px;border:1px solid rgba(20,32,46,.2);border-radius:999px;background:rgba(255,255,255,.94);color:inherit;font:inherit;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.18)}'
    + '.b:hover{background:#fff}.b:focus-visible{outline:2px solid #1f6feb;outline-offset:2px}'
    + '.d{width:8px;height:8px;border-radius:50%;background:#2e9e5b}'
    + '.p{position:absolute;left:0;bottom:calc(100% + 8px);min-width:230px;padding:14px;border:1px solid rgba(20,32,46,.2);border-radius:14px;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.25)}'
    + '.p[hidden]{display:none}.t{margin:0 0 2px;font-size:12px;color:#5d6b7c}.r{margin:0 0 10px;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}'
    + '.o{width:100%;padding:7px;border:1px solid rgba(20,32,46,.25);border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}.o:hover{background:#eef2f7}'
    + '@media (prefers-color-scheme:dark){.w{color:#e8eef6}.b,.p{background:rgba(22,33,46,.96);border-color:rgba(232,238,246,.25)}.b:hover{background:#1d2b3b}.t{color:#98a6b8}.o{border-color:rgba(232,238,246,.3)}.o:hover{background:#243447}}';
  try {
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch (e) {
    var st = document.createElement('style');
    st.textContent = css;
    root.appendChild(st);
  }

  var wrap = document.createElement('div');
  wrap.className = 'w';
  var pop = document.createElement('div');
  pop.className = 'p';
  pop.hidden = true;
  var t = document.createElement('p');
  t.className = 't';
  t.textContent = 'Time left until the password is asked again';
  var rem = document.createElement('p');
  rem.className = 'r';
  rem.textContent = '–';
  var out = document.createElement('button');
  out.type = 'button';
  out.className = 'o';
  out.textContent = 'Sign out now';
  pop.append(t, rem, out);
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'b';
  btn.setAttribute('aria-expanded', 'false');
  var dot = document.createElement('span');
  dot.className = 'd';
  btn.append(dot, document.createTextNode('powered by webmanager'));
  wrap.append(pop, btn);
  root.appendChild(wrap);

  var end = null;
  function fmt(s) {
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h > 0 ? h + ':' + two(m) : m) + ':' + two(x) + (h > 0 ? ' h' : ' min');
  }
  function tick() {
    if (end === null) return;
    var s = Math.max(0, Math.round((end - Date.now()) / 1000));
    rem.textContent = fmt(s);
    if (s === 0) location.reload();
  }
  function load() {
    return fetch('/__wm_gate/status', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.active) { location.reload(); return; }
        end = Date.now() + j.remaining * 1000;
        tick();
      })
      .catch(function () { rem.textContent = 'not available'; });
  }
  btn.addEventListener('click', function (ev) {
    ev.stopPropagation();
    pop.hidden = !pop.hidden;
    btn.setAttribute('aria-expanded', String(!pop.hidden));
    if (!pop.hidden) load();
  });
  document.addEventListener('click', function () {
    if (!pop.hidden) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  });
  out.addEventListener('click', function () {
    fetch('/__wm_gate/logout', { method: 'POST', credentials: 'same-origin' }).then(function () { location.reload(); });
  });
  setInterval(tick, 1000);
  document.body.appendChild(host);
  load();
})();
