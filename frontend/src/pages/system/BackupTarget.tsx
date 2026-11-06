import { useState } from 'preact/hooks';
import { PROVIDERS, PROVIDER_ORDER, buildCommand, validate, type ProviderId } from '../../backupTarget.ts';
import { Field, Notice, Panel } from '../../forms.tsx';
import { toast } from '../../runtime.ts';
import { Icon } from '../../ui.tsx';
import { Rich } from '../../Rich.tsx';

/**
 * Picks the kind of external target and builds the command for the server. The dashboard never sees or stores credentials:
 * the command asks for the secret on the server's terminal.
 */
export function BackupTarget({ configured }: { configured: boolean }) {
  const [id, setId] = useState<ProviderId>('hetzner');
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState(false);
  const p = PROVIDERS[id];
  const errors = validate(p, values);
  const ready = Object.keys(errors).length === 0;
  const command = ready ? buildCommand(p, values) : '';
  const pick = (next: ProviderId) => {
    setId(next);
    setValues({});
    setShown(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast('Command copied');
    } catch {
      toast('Copying not possible. Please select the command and copy it.', 'err');
    }
  };

  return (
    <Panel title={configured ? 'Change external target' : 'Set up external target'}>
      <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>
        {'Choose where the backups should go. The interface only asks for the details and builds the command; you enter the credentials on the server and they stay there (never visible in the dashboard).'}
      </p>
      <div class="provider-grid" role="radiogroup" aria-label="Type of target">
        {PROVIDER_ORDER.map((k) => (
          <button key={k} class={`provider${id === k ? ' active' : ''}`} role="radio" aria-checked={id === k} onClick={() => pick(k)}>
            <strong>{PROVIDERS[k].title}</strong>
            <span class="muted small">{PROVIDERS[k].summary}</span>
          </button>
        ))}
      </div>
      <div class="form-grid" style={{ marginTop: 'var(--sp-4)' }}>
        {p.fields.map((f) => (
          <Field key={`${id}-${f.key}`} label={f.label + (f.required ? ' *' : '')} htmlFor={`bt-${f.key}`} hint={shown && errors[f.key] ? <span class="err-text">{errors[f.key]}</span> : f.hint}>
            <input
              id={`bt-${f.key}`}
              class="input"
              value={values[f.key] ?? ''}
              placeholder={f.placeholder ?? f.fallback}
              autocomplete="off"
              spellcheck={false}
              aria-invalid={shown && !!errors[f.key] ? true : undefined}
              onInput={(e) => setValues({ ...values, [f.key]: e.currentTarget.value })}
            />
          </Field>
        ))}
      </div>
      <div class="row" style={{ marginTop: 'var(--sp-3)' }}>
        <button class="btn primary" onClick={() => setShown(true)}>Generate command</button>
      </div>
      {shown && !ready && <Notice tone="err">Please check the highlighted details.</Notice>}
      {shown && ready && (
        <>
          <Notice tone="ok"><Rich text="Run this command once on the server. Afterwards it asks for: {secret}. Nothing is stored in the dashboard." with={{ secret: <b>{p.secret}</b> }} /></Notice>
          <pre class="log compact" tabIndex={0}>{`sudo apt-get install rclone\n${command}`}</pre>
          <div class="row">
            <button class="btn" onClick={() => void copy()}><Icon name="clipboard-list" />Copy</button>
          </div>
          <p class="muted small">
            {'The command checks the connection, creates the backup passphrase (please store it outside the server) and enables the encrypted upload. Afterwards run “Upload to external target” and the restore test here.'}
          </p>
        </>
      )}
    </Panel>
  );
}
