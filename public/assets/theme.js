/* Sets the theme before the first paint: saved choice, else the system preference. */
(function () {
  try {
    var t = localStorage.getItem('wm.theme');
    if (t !== 'light' && t !== 'dark') t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
  } catch (e) { document.documentElement.dataset.theme = 'dark'; }
})();
