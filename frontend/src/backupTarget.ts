/**
 * External backup targets: what the wizard asks for and the command it builds. The dashboard never stores credentials:
 * the command runs on the server, which asks for the secret itself (scripts/backup-remote.sh setup --provider ...).
 * The patterns mirror the ones in that script.
 */
export type ProviderId = 'hetzner' | 'sftp' | 's3' | 'b2';

export interface FieldDef {
  key: string;
  flag: string;
  label: string;
  hint?: string;
  placeholder?: string;
  required: boolean;
  pattern: RegExp;
  /** value used when the field stays empty (not added to the command) */
  fallback?: string;
}

export interface ProviderDef {
  id: ProviderId;
  title: string;
  summary: string;
  secret: string;
  fields: FieldDef[];
}

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const PATH = /^[A-Za-z0-9._/-]*$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER = /^[A-Za-z0-9._@-]{1,100}$/;
const KEY = /^[A-Za-z0-9/+=._-]{1,200}$/;
const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;

const name = (fallback: string): FieldDef => ({ key: 'name', flag: '--name', label: 'Name of the target', hint: 'Free choice, letters, digits, _ and - only.', required: false, pattern: NAME, fallback });
const path = (hint: string, fallback?: string): FieldDef => ({ key: 'path', flag: '--path', label: 'Folder', hint, placeholder: fallback, required: false, pattern: PATH, fallback });

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  hetzner: {
    id: 'hetzner',
    title: 'Hetzner Storage Box',
    summary: 'SFTP on port 23',
    secret: 'Password of the Storage Box',
    fields: [
      { key: 'user', flag: '--user', label: 'Username', hint: 'Example: u123456 or u123456-sub1 (sub-account)', placeholder: 'u123456', required: true, pattern: /^u[0-9]+(-sub[0-9]+)?$/ },
      path('Folder on the Storage Box', 'webmanager-backups'),
      name('hetzner'),
    ],
  },
  sftp: {
    id: 'sftp',
    title: 'SFTP-Server',
    summary: 'Any server with SSH/SFTP',
    secret: 'Password (not needed with a key file)',
    fields: [
      { key: 'host', flag: '--host', label: 'Server', placeholder: 'backup.example.com', required: true, pattern: HOST },
      { key: 'port', flag: '--port', label: 'Port', placeholder: '22', required: false, pattern: /^[0-9]{1,5}$/ },
      { key: 'user', flag: '--user', label: 'Username', required: true, pattern: USER },
      { key: 'keyFile', flag: '--key-file', label: 'Key file on the server', hint: 'Optional: path to the private SSH key instead of a password.', placeholder: '/root/.ssh/backup_ed25519', required: false, pattern: /^[A-Za-z0-9._/-]+$/ },
      path('Folder on the server', 'webmanager-backups'),
      name('wmsftp'),
    ],
  },
  s3: {
    id: 's3',
    title: 'Amazon S3 and compatible',
    summary: 'AWS, Wasabi, MinIO, Cloudflare R2 and others',
    secret: 'Secret Access Key',
    fields: [
      { key: 'bucket', flag: '--bucket', label: 'Bucket', required: true, pattern: BUCKET },
      { key: 'accessKey', flag: '--access-key', label: 'Access Key ID', required: true, pattern: KEY },
      { key: 'endpoint', flag: '--endpoint', label: 'Endpoint', hint: 'Only for non-AWS services, e.g. https://s3.eu-central-1.wasabisys.com', required: false, pattern: /^https?:\/\/[A-Za-z0-9._:/-]+$/ },
      { key: 'region', flag: '--region', label: 'Region', placeholder: 'eu-central-1', required: false, pattern: /^[A-Za-z0-9-]{1,40}$/ },
      { key: 's3Provider', flag: '--s3-provider', label: 'Provider type', hint: 'AWS, Wasabi, Minio, Cloudflare, Other …', placeholder: 'AWS', required: false, pattern: /^[A-Za-z0-9]{1,30}$/ },
      path('Folder in the bucket', ''),
      name('wms3'),
    ],
  },
  b2: {
    id: 'b2',
    title: 'Backblaze B2',
    summary: 'Low-cost object storage',
    secret: 'Application Key',
    fields: [
      { key: 'bucket', flag: '--bucket', label: 'Bucket', required: true, pattern: BUCKET },
      { key: 'account', flag: '--account', label: 'Key ID (keyID)', required: true, pattern: KEY },
      path('Folder in the bucket', ''),
      name('wmb2'),
    ],
  },
};

export const PROVIDER_ORDER: ProviderId[] = ['hetzner', 'sftp', 's3', 'b2'];

export const SETUP_SCRIPT = 'sudo /opt/webmanager/scripts/backup-remote.sh';

/** Field errors by key; an empty object means the values are fine. */
export function validate(p: ProviderDef, values: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of p.fields) {
    const v = (values[f.key] ?? '').trim();
    if (!v) {
      if (f.required) errors[f.key] = 'Please fill in.';
    } else if (!f.pattern.test(v)) errors[f.key] = 'Contains characters that are not allowed or has the wrong format.';
  }
  const port = (values.port ?? '').trim();
  if (p.id === 'sftp' && port && !errors.port && (Number(port) < 1 || Number(port) > 65535)) errors.port = 'Port 1 to 65535.';
  return errors;
}

/** Single-quotes a value for a POSIX shell unless it is plainly safe. */
export function shellQuote(v: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** The command to run on the server. Secrets are not part of it: the script asks for them. */
export function buildCommand(p: ProviderDef, values: Record<string, string>): string {
  const parts = [SETUP_SCRIPT, 'setup', '--provider', p.id];
  for (const f of p.fields) {
    const v = (values[f.key] ?? '').trim() || f.fallback || '';
    if (v) parts.push(f.flag, shellQuote(v));
  }
  return parts.join(' ');
}
