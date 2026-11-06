import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { isCurrent, navFor } from './nav.ts';
import { Palette } from './Palette.tsx';
import { useTheme } from './runtime.ts';
import type { Me } from './types.ts';
import { Icon, Toasts, TopBar } from './ui.tsx';

export function Shell({ me, route, onLogout, only, children }: { me: Me; route: string; onLogout: () => void; /** locked dashboard (mandatory 2FA setup): the only page that is reachable */ only?: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const groups = navFor(me.user.role)
    .map((g) => ({ ...g, items: only ? g.items.filter((i) => i.to === only) : g.items }))
    .filter((g) => g.items.length > 0);

  useEffect(() => setOpen(false), [route]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === 'Escape') setOpen(false);
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);

  const initial = (me.user.name || me.user.email).slice(0, 1).toUpperCase();
  return (
    <div class="app">
      <aside class={`side${open ? ' open' : ''}`} id="side">
        <a class="brand" href="#/" aria-label="To the overview">
          <img src={me.brand.logo} alt="" />
          <span>
            {me.brand.name}
            <small>{me.brand.product}</small>
          </span>
        </a>
        <nav aria-label="Main navigation">
          {groups.map((g) => (
            <>
              <div class="nav-label">{g.label}</div>
              {g.items.map((i) => {
                const current = isCurrent(i.to, route);
                return (
                  <a class="nav" href={`#${i.to}`} aria-current={current ? 'page' : undefined}>
                    <Icon name={i.icon} />
                    {i.label}
                  </a>
                );
              })}
            </>
          ))}
        </nav>
        <div class="side-foot">
          <button class="nav" onClick={onLogout}>
            <Icon name="log-out" />
            {'Sign out'}
          </button>
          <div class="ver">Version {me.version}</div>
          <div class="ver credit">
            made with <span class="heart" aria-label="Liebe">♥</span> by{' '}
            <a href="https://github.com/Drimzo-Development" target="_blank" rel="noopener noreferrer">Drimzo Development</a>
          </div>
        </div>
      </aside>
      {open && <div class="scrim" onClick={() => setOpen(false)} />}
      <div class="col">
        <header class="top">
          <button class="btn ghost icon menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Open menu" aria-expanded={open} aria-controls="side">
            <Icon name="menu" />
          </button>
          <button class="btn search" onClick={() => setPalette(true)}>
            <Icon name="search" />
            <span class="l">Search or command …</span>
            <kbd>Ctrl K</kbd>
          </button>
          <span class="grow" />
          <button class="btn ghost icon" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
          <span class="avatar" title={me.user.email}>
            {initial}
          </span>
        </header>
        {me.two_factor_missing && (
          <div class="banner">
            <Icon name="alert" /> {'Two-factor authentication is mandatory.'} <a href="#/account">Set it up now under “My account”</a>
          </div>
        )}
        {children}
      </div>
      <Palette open={palette} onClose={() => setPalette(false)} me={me} onLogout={onLogout} onTheme={toggleTheme} />
      <TopBar />
      <Toasts />
    </div>
  );
}
