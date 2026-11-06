/** Pure helpers of the console page (tested without a browser). */

/** Address of the console WebSocket: same host as the page, wss on HTTPS. The ticket is not part of it (see protocolFor). */
export function wsUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/__console`;
}

/** The one-time ticket travels as WebSocket subprotocol, so it never shows up in an address, a log or the browser history. */
export function protocolFor(ticket: string): string {
  return `wm-console.${ticket}`;
}

const REASONS: Record<string, string> = {
  'shell-exited': 'The shell ended',
  idle: 'Closed after 15 minutes without input',
  'time-limit': 'Closed after the maximum session time of 2 hours',
  'no-answer': 'Closed because the browser stopped answering',
  closed: 'Disconnected',
  killed: 'Closed: signed out, access removed or ended by an administrator',
  error: 'The session could not be started',
  'protocol-error': 'Connection error',
  'connection-error': 'Connection error',
};

/** Text for the end of a session from the agent's { type: 'exit', reason, code } message. */
export function exitText(msg: { reason?: string; code?: number | null }): string {
  const base = REASONS[msg.reason ?? ''] ?? 'Session ended';
  return msg.reason === 'shell-exited' && typeof msg.code === 'number' ? `${base} (exit code ${msg.code})` : base;
}

/** Message the browser can show for a refused ticket request: the server's own words when it sent some. */
export function failureText(status: number, message: string): string {
  if (status === 401) return 'You are signed out. Please sign in again in the dashboard.';
  if (message) return message;
  if (status === 403) return 'The console is only available to administrators.';
  if (status === 409) return 'The website is not running.';
  if (status === 429) return 'Too many failed attempts or too many consoles are open.';
  return 'The console could not be started.';
}

/** xterm hands binary input (mouse reports) as a string with one byte per character. */
export function binaryBytes(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
