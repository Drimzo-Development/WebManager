import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from './api.ts';
import { navFor } from './nav.ts';
import type { Me, SiteSummary } from './types.ts';
import { Icon } from './ui.tsx';

interface Entry {
  label: string;
  kind: string;
  icon: string;
  run: () => void;
}

export function Palette({ open, onClose, me, onLogout, onTheme }: { open: boolean; onClose: () => void; me: Me; onLogout: () => void; onTheme: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [sites, setSites] = useState<SiteSummary[]>([]);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) {
      setQ('');
      setSel(0);
      d.showModal();
      input.current?.focus();
      api.get<{ sites: SiteSummary[] }>('/api/v1/sites').then((r) => setSites(r.sites), () => undefined);
    } else if (!open && d.open) d.close();
  }, [open]);

  const go = (to: string) => () => { location.hash = to; };
  const entries: Entry[] = [
    ...navFor(me.user.role).flatMap((g) => g.items.map((i) => ({ label: i.label, kind: 'Page', icon: i.icon, run: go(i.to) }))),
    ...sites.map((s) => ({ label: s.name, kind: 'Website', icon: 'globe', run: go(`/sites/${s.id}`) })),
    ...(['operator', 'admin'].includes(me.user.role) ? [{ label: 'Create new website', kind: 'Action', icon: 'plus', run: go('/sites/new') }] : []),
    { label: 'Switch theme', kind: 'Action', icon: 'moon', run: onTheme },
    { label: 'Sign out', kind: 'Action', icon: 'log-out', run: onLogout },
  ];
  const needle = q.trim().toLowerCase();
  const shown = entries.filter((e) => e.label.toLowerCase().includes(needle));
  const at = Math.min(sel, Math.max(shown.length - 1, 0));
  const choose = (e: Entry | undefined) => {
    if (!e) return;
    onClose();
    e.run();
  };

  return (
    <dialog ref={dlg} aria-label="Search and commands" onClose={onClose} onClick={(e) => e.target === dlg.current && onClose()}>
      <input
        ref={input}
        class="pal-input"
        placeholder="Website, page or action …"
        autocomplete="off"
        aria-label="Search"
        value={q}
        onInput={(e) => {
          setQ(e.currentTarget.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel(Math.min(at + 1, shown.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel(Math.max(at - 1, 0));
          } else if (e.key === 'Enter') choose(shown[at]);
        }}
      />
      <div class="pal-list" role="listbox">
        {shown.map((e, n) => (
          <button key={e.kind + e.label} class="pal-item" role="option" aria-selected={n === at} onClick={() => choose(e)}>
            <Icon name={e.icon} small />
            {e.label}
            <small>{e.kind}</small>
          </button>
        ))}
        {shown.length === 0 && <p class="muted small" style={{ padding: '1rem' }}>No results</p>}
      </div>
    </dialog>
  );
}
