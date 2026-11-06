import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Field, Loading, Notice, Panel, SaveBar, Toggle, useSaver } from '../../forms.tsx';
import { toast, useLoad } from '../../runtime.ts';
import { fill } from '../../i18n.ts';
import { askConfirm } from '../../confirm.tsx';
import { Rich } from '../../Rich.tsx';

interface Brand {
  name: string;
  defaultName: string;
  color: string | null;
  hasLogo: boolean;
  logoUrl: string;
  product: string;
}

/** `onChanged` refreshes the shell (sidebar name and logo come from /api/v1/me). */
export function BrandSection({ onChanged }: { onChanged: () => void }) {
  const load = useLoad(() => api.get<Brand>('/api/branding'));
  const [f, setF] = useState<{ name: string; useColor: boolean; color: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (load.data) setF({ name: load.data.name, useColor: !!load.data.color, color: load.data.color ?? '#5b8def' });
  }, [load.data]);
  const after = () => {
    load.reload();
    onChanged();
  };
  const save = useSaver(after);
  const logo = useSaver(after);
  const reset = useSaver(after);

  return (
    <div class="stack">
      <Panel title="Name and color">
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>{'The name appears in the sidebar, on the sign-in page, in the browser title and in emails. The accent color tints buttons and links.'} <b><Rich text="The note “{product}” always stays visible." with={{ product: load.data?.product ?? 'webmanager' }} /></b></p>
        <Loading load={load}>
          {(b) => f && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save.run(() => api.put('/api/branding', { name: f.name.trim(), color: f.useColor ? f.color : '' }), 'Saved');
              }}
            >
              <div class="form-grid">
                <Field label="Name" htmlFor="br-name" hint={fill('1 to 40 characters. Default: {defaultName}.', { defaultName: b.defaultName })}><input id="br-name" class="input" required maxLength={40} autocomplete="off" value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></Field>
                <div>
                  <Toggle id="br-use" checked={f.useColor} onChange={(v) => setF({ ...f, useColor: v })} label="Custom accent color" />
                  <Field label="Color" htmlFor="br-color" hint="Must be dark enough for white text."><input id="br-color" type="color" disabled={!f.useColor} value={f.color} onInput={(e) => setF({ ...f, color: e.currentTarget.value })} /></Field>
                </div>
              </div>
              <SaveBar busy={save.busy} error={save.error} progress={save.progress}>
                <button class="btn danger" type="button" disabled={reset.busy} onClick={async () => (await askConfirm('Reset appearance?', 'Reset name, color and logo to the defaults?', 'Reset everything')) && void reset.run(() => api.del('/api/branding'), 'Reset')}>Reset everything</button>
              </SaveBar>
            </form>
          )}
        </Loading>
      </Panel>
      <Panel title="Logo">
        <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>Shown in the sidebar, on the sign-in page, as the tab icon, on the pages of password-protected websites and in emails. PNG, JPEG, WebP or SVG up to 512 KB; ideally square. SVG logos do not appear in emails because mail clients cannot display them.</p>
        {load.data && <div class="row"><img class="logo-preview" src={load.data.logoUrl} alt="Current logo" width={56} height={56} /><span class="muted small">{load.data.hasLogo ? 'Custom logo' : 'Default logo'}</span></div>}
        <div class="row" style={{ marginTop: 'var(--sp-3)' }}>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" aria-label="Choose logo" />
          <button class="btn" disabled={logo.busy} onClick={() => {
            const file = input.current?.files?.[0];
            if (!file) return toast('Please choose an image file first.', 'err');
            const body = new FormData();
            body.append('logo', file);
            void logo.run(() => api.post('/api/branding/logo', body), 'Logo saved');
          }}>Upload</button>
          {load.data?.hasLogo && <button class="btn ghost" disabled={logo.busy} onClick={() => void logo.run(() => api.del('/api/branding/logo'), 'Logo removed')}>Remove logo</button>}
        </div>
        {(logo.error || reset.error) && <Notice tone="err">{logo.error || reset.error}</Notice>}
      </Panel>
    </div>
  );
}

