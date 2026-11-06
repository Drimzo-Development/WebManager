import { useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Field, Loading, Notice, Panel, SaveBar, Toggle, useDraft, useSaver } from '../../forms.tsx';
import { useLoad } from '../../runtime.ts';
import { JobLog } from '../site/JobLog.tsx';
import { Rich } from '../../Rich.tsx';

interface Notify {
  smtp_host: string;
  smtp_port: number;
  smtp_security: 'starttls' | 'tls' | 'none';
  smtp_user: string;
  has_password: boolean;
  smtp_from: string;
  enabled: boolean;
  recipients: string;
  site_down: boolean;
  cert: boolean;
  cert_days: number;
  jobs: boolean;
  backup: boolean;
  disk: boolean;
  disk_percent: number;
  update_notice: boolean;
  login_alert: boolean;
  bans: boolean;
  bans_threshold: number;
  resources: boolean;
  mem_percent: number;
  site_disk_gb: number;
  webhook_host: string;
  webhook_secret_set: boolean;
  ntfy_host: string;
  ntfy_token_set: boolean;
  telegram_set: boolean;
  telegram_chat: string;
}

/** Secrets and addresses are never sent back by the server: these fields are empty = keep, filled = replace. */
interface Channels {
  webhook_url: string;
  webhook_secret: string;
  clear_webhook: boolean;
  ntfy_url: string;
  ntfy_token: string;
  clear_ntfy: boolean;
  telegram_token: string;
  telegram_chat: string;
  clear_telegram: boolean;
}

const NO_CHANNELS: Channels = { webhook_url: '', webhook_secret: '', clear_webhook: false, ntfy_url: '', ntfy_token: '', clear_ntfy: false, telegram_token: '', telegram_chat: '', clear_telegram: false };

const num = (v: string, fb: number) => (v.trim() === '' || Number.isNaN(Number(v)) ? fb : Number(v));

export function NotifySection() {
  const load = useLoad(() => api.get<Notify>('/api/settings/notifications'));
  const [d, patch] = useDraft(load);
  const [pw, setPw] = useState('');
  const [ch, setCh] = useState<Channels>(NO_CHANNELS);
  const setC = <K extends keyof Channels>(k: K, v: Channels[K]) => setCh((c) => ({ ...c, [k]: v }));
  const [job, setJob] = useState<number | null>(null);
  const save = useSaver(load.reload);
  const test = useSaver();
  const body = () => ({ ...d, smtp_password: pw, ...ch, telegram_chat: ch.telegram_chat || undefined });
  const put = async () => {
    await api.put('/api/settings/notifications', body());
    setPw('');
    setCh(NO_CHANNELS);
  };
  const set = <K extends keyof Notify>(k: K, v: Notify[K]) => patch({ [k]: v } as Partial<Notify>);
  return (
    <Loading load={load}>
      {(n) => d && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save.run(put, 'Saved');
          }}
        >
          <div class="stack">
            <Panel title="Notifications">
              <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>WebManager checks every minute whether websites are running and answer HTTP requests, and certificates daily. On problems it notifies you through every channel below that is set up: email, webhook, ntfy or Telegram.</p>
              <Toggle id="nf-on" checked={d.enabled} onChange={(v) => set('enabled', v)} label="Enable notifications" />
            </Panel>
            <Panel title="When to notify?">
              <Toggle id="nf-down" checked={d.site_down} onChange={(v) => set('site_down', v)} label="Website unreachable / reachable again" />
              <Toggle id="nf-jobs" checked={d.jobs} onChange={(v) => set('jobs', v)} label="Task failed" />
              <Toggle id="nf-cert" checked={d.cert} onChange={(v) => set('cert', v)} label="Certificate expires soon" />
              <Field label="Warn … days before" htmlFor="nf-days"><input id="nf-days" class="input inline" type="number" min={1} max={60} value={d.cert_days} onInput={(e) => set('cert_days', num(e.currentTarget.value, 14))} /></Field>
              <Toggle id="nf-backup" checked={d.backup} onChange={(v) => set('backup', v)} label="Backup failed, overdue or restore test failed" />
              <Toggle id="nf-login" checked={d.login_alert} onChange={(v) => set('login_alert', v)} label="Sign-in warning to the person who signed in (to their email address)" />
              <Toggle id="nf-upd" checked={d.update_notice} onChange={(v) => set('update_notice', v)} label="New version available and result of automatic updates" />
              <Toggle id="nf-disk" checked={d.disk} onChange={(v) => set('disk', v)} label="Disk space is running low" />
              <Field label="From … % usage" htmlFor="nf-pct"><input id="nf-pct" class="input inline" type="number" min={50} max={99} value={d.disk_percent} onInput={(e) => set('disk_percent', num(e.currentTarget.value, 90))} /></Field>
              <Toggle id="nf-res" checked={d.resources} onChange={(v) => set('resources', v)} label="Website memory is running out, or it was restarted after running out of memory" />
              <Field label="Memory warning from … % of the limit (for 5 minutes)" htmlFor="nf-mem"><input id="nf-mem" class="input inline" type="number" min={50} max={99} value={d.mem_percent} onInput={(e) => set('mem_percent', num(e.currentTarget.value, 90))} /></Field>
              <Field label="Website uses more than … GB of disk space (0 = off)" htmlFor="nf-sdisk" hint="Files, logs and database of one website, measured once a day. At most one message per week and website."><input id="nf-sdisk" class="input inline" type="number" min={0} step="0.5" value={d.site_disk_gb} onInput={(e) => set('site_disk_gb', num(e.currentTarget.value, 0))} /></Field>
              <Toggle id="nf-bans" checked={d.bans} onChange={(v) => set('bans', v)} label="Wave of automatic bans (flood protection)" hint="Needs the automatic ban under Protection. At most one message per hour." />
              <Field label="From … addresses within 15 minutes" htmlFor="nf-bans-n"><input id="nf-bans-n" class="input inline" type="number" min={2} max={1000} value={d.bans_threshold} onInput={(e) => set('bans_threshold', num(e.currentTarget.value, 10))} /></Field>
            </Panel>
            <Panel title="Email">
              <Field label="Recipients (one address per line)" htmlFor="nf-to" hint="At most 20. Leave empty if you do not want email."><textarea id="nf-to" class="input" rows={3} spellcheck={false} value={d.recipients} onInput={(e) => set('recipients', e.currentTarget.value)} /></Field>
              <h3 class="small" style={{ margin: 'var(--sp-3) 0' }}>SMTP server</h3>
              <div class="form-grid">
                <Field label="Server" htmlFor="nf-host"><input id="nf-host" class="input" autocomplete="off" placeholder="smtp.example.com" value={d.smtp_host} onInput={(e) => set('smtp_host', e.currentTarget.value)} /></Field>
                <Field label="Port" htmlFor="nf-port"><input id="nf-port" class="input" type="number" min={1} max={65535} value={d.smtp_port} onInput={(e) => set('smtp_port', num(e.currentTarget.value, 587))} /></Field>
                <Field label="Encryption" htmlFor="nf-sec">
                  <select id="nf-sec" class="input" value={d.smtp_security} onChange={(e) => set('smtp_security', e.currentTarget.value as Notify['smtp_security'])}>
                    <option value="starttls">STARTTLS (port 587)</option><option value="tls">SSL/TLS (port 465)</option><option value="none">None (not recommended)</option>
                  </select>
                </Field>
                <Field label="Sender address" htmlFor="nf-from"><input id="nf-from" class="input" type="email" autocomplete="off" placeholder="webmanager@example.com" value={d.smtp_from} onInput={(e) => set('smtp_from', e.currentTarget.value)} /></Field>
                <Field label="Username" htmlFor="nf-user"><input id="nf-user" class="input" autocomplete="off" value={d.smtp_user} onInput={(e) => set('smtp_user', e.currentTarget.value)} /></Field>
                <Field label="Password" htmlFor="nf-pw" hint={n.has_password ? 'Saved, leave empty to keep.' : undefined}><input id="nf-pw" class="input" type="password" autocomplete="new-password" value={pw} onInput={(e) => setPw(e.currentTarget.value)} /></Field>
              </div>
            </Panel>
            <Panel title="Webhook">
              <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}><Rich text="Sends a JSON message (HTTPS POST) with the fields {fields} plus {text} and {content}, so Slack, Mattermost, Discord and similar services accept it directly." with={{ fields: <><code>kind</code>, <code>title</code>, <code>message</code>, <code>facts</code>, <code>time</code></>, text: <code>text</code>, content: <code>content</code> }} /></p>
              <div class="form-grid">
                <Field label="Address" htmlFor="nf-wh" hint={n.webhook_host ? `Saved (${n.webhook_host}), leave empty to keep.` : 'Must start with https://.'}><input id="nf-wh" class="input" type="url" autocomplete="off" placeholder="https://hooks.example.com/…" value={ch.webhook_url} onInput={(e) => setC('webhook_url', e.currentTarget.value)} /></Field>
                <Field label="Secret (optional)" htmlFor="nf-whs" hint={n.webhook_secret_set ? 'Saved, leave empty to keep. ' : 'Signs every message: header X-WebManager-Signature = sha256=HMAC of the body.'}><input id="nf-whs" class="input" type="password" autocomplete="new-password" value={ch.webhook_secret} onInput={(e) => setC('webhook_secret', e.currentTarget.value)} /></Field>
              </div>
              {n.webhook_host && <Toggle id="nf-wh-clear" checked={ch.clear_webhook} onChange={(v) => setC('clear_webhook', v)} label="Remove the saved webhook when saving" />}
            </Panel>
            <Panel title="ntfy">
              <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}><Rich text="Push messages to your phone through {link} (ntfy.sh or your own server). The topic works like a password: choose a long, hard-to-guess name." with={{ link: <a href="https://ntfy.sh" target="_blank" rel="noopener noreferrer">ntfy</a> }} /></p>
              <div class="form-grid">
                <Field label="Address with topic" htmlFor="nf-nt" hint={n.ntfy_host ? `Saved (${n.ntfy_host}), leave empty to keep.` : 'e.g. https://ntfy.sh/my-long-secret-topic'}><input id="nf-nt" class="input" type="url" autocomplete="off" placeholder="https://ntfy.sh/…" value={ch.ntfy_url} onInput={(e) => setC('ntfy_url', e.currentTarget.value)} /></Field>
                <Field label="Access token (optional)" htmlFor="nf-ntt" hint={n.ntfy_token_set ? 'Saved, leave empty to keep.' : 'For protected topics.'}><input id="nf-ntt" class="input" type="password" autocomplete="new-password" value={ch.ntfy_token} onInput={(e) => setC('ntfy_token', e.currentTarget.value)} /></Field>
              </div>
              {n.ntfy_host && <Toggle id="nf-nt-clear" checked={ch.clear_ntfy} onChange={(v) => setC('clear_ntfy', v)} label="Remove the saved ntfy topic when saving" />}
            </Panel>
            <Panel title="Telegram">
              <p class="muted small" style={{ marginBottom: 'var(--sp-3)' }}>Create a bot with @BotFather, write to it (or add it to a group or channel) and enter the bot token and the chat here.</p>
              <div class="form-grid">
                <Field label="Bot token" htmlFor="nf-tg" hint={n.telegram_set ? 'Saved, leave empty to keep.' : undefined}><input id="nf-tg" class="input" type="password" autocomplete="new-password" placeholder="123456789:AA…" value={ch.telegram_token} onInput={(e) => setC('telegram_token', e.currentTarget.value)} /></Field>
                <Field label="Chat" htmlFor="nf-tgc" hint={n.telegram_chat ? `Saved: ${n.telegram_chat}` : 'Number (e.g. -1001234567890) or @channelname.'}><input id="nf-tgc" class="input" autocomplete="off" value={ch.telegram_chat} onInput={(e) => setC('telegram_chat', e.currentTarget.value)} /></Field>
              </div>
              {n.telegram_set && <Toggle id="nf-tg-clear" checked={ch.clear_telegram} onChange={(v) => setC('clear_telegram', v)} label="Remove the saved Telegram bot when saving" />}
            </Panel>
            <SaveBar busy={save.busy} error={save.error} progress={save.progress}>
              <button class="btn" type="button" disabled={test.busy} onClick={() => void test.run(async () => { await put(); setJob((await api.post<{ job: number }>('/api/settings/notifications/test')).job); })}>Send test notification</button>
            </SaveBar>
            {test.error && <Notice tone="err">{test.error}</Notice>}
            {job !== null && <JobLog jobId={job} />}
          </div>
        </form>
      )}
    </Loading>
  );
}
