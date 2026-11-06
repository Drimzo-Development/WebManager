import { SYSTEM_SUBS, systemHref } from '../system.ts';
import type { Me } from '../types.ts';
import { ErrorNote, Icon } from '../ui.tsx';
import { BackupSection } from './system/Backup.tsx';
import { BrandSection } from './system/Brand.tsx';
import { DnsSection } from './system/Dns.tsx';
import { NotifySection } from './system/Notify.tsx';
import { OverviewSection } from './system/Overview.tsx';
import { DomainSection, LoginSection, ProtectSection } from './system/Security.tsx';
import { StorageSection } from './system/Storage.tsx';
import { UpdateSection } from './system/Update.tsx';

function Section({ sub, onBrand }: { sub: string; onBrand: () => void }) {
  switch (sub) {
    case 'update': return <UpdateSection />;
    case 'backup': return <BackupSection />;
    case 'storage': return <StorageSection />;
    case 'login': return <LoginSection />;
    case 'protect': return <ProtectSection />;
    case 'domain': return <DomainSection />;
    case 'dns': return <DnsSection />;
    case 'brand': return <BrandSection onChanged={onBrand} />;
    case 'notify': return <NotifySection />;
    default: return <OverviewSection />;
  }
}

export function SystemPage({ me, sub, onBrand }: { me: Me; sub: string; onBrand: () => void }) {
  if (me.user.role !== 'admin') return <main><ErrorNote message="You do not have permission for this." /></main>;
  const groups = [...new Set(SYSTEM_SUBS.map((s) => s.group))];
  return (
    <main>
      <div class="page-head">
        <div>
          <p class="crumbs muted">Administration</p>
          <h1>System</h1>
          <p class="muted">Status, maintenance, security and notifications of WebManager.</p>
        </div>
      </div>
      <nav class="sysnav" aria-label="System sections">
        {groups.map((g) => (
          <div class="sysnav-group" key={g}>
            <span class="muted small">{g}</span>
            <div class="subtabs">
              {SYSTEM_SUBS.filter((s) => s.group === g).map((s) => (
                <a key={s.key} class={`chip${s.key === sub ? ' active' : ''}`} href={systemHref(s.key)} aria-current={s.key === sub ? 'page' : undefined}><Icon name={s.icon} small />{s.label}</a>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <Section sub={sub} onBrand={onBrand} />
    </main>
  );
}
