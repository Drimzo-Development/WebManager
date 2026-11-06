import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './console.css';
import { binaryBytes, exitText, failureText, protocolFor, wsUrl } from './consoleUtil.ts';

const siteId = Number(document.body.dataset.site);
const csrf = document.querySelector('meta[name="csrf"]')?.getAttribute('content') ?? '';
const statusEl = document.getElementById('status') as HTMLElement;
const connectBtn = document.getElementById('connect') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement;
const host = document.getElementById('term') as HTMLElement;
const reauthForm = document.getElementById('reauth') as HTMLFormElement;
const passEl = document.getElementById('re-pass') as HTMLInputElement;
const codeWrap = document.getElementById('re-code-wrap') as HTMLElement;
const codeEl = document.getElementById('re-code') as HTMLInputElement;
const reauthMsg = document.getElementById('re-msg') as HTMLElement;

/** The server wants the password (and code) again before it opens a shell. */
class ReauthRequired extends Error {
  readonly needsCode: boolean;
  constructor(needsCode: boolean) {
    super('Please confirm your password.');
    this.needsCode = needsCode;
  }
}

const term = new Terminal({
  cursorBlink: true,
  convertEol: false,
  scrollback: 5000,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 14,
  theme: { background: '#0f1115', foreground: '#d7dae0', cursor: '#5b8def', selectionBackground: '#33415c' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(host);

const encoder = new TextEncoder();
let socket: WebSocket | null = null;
let busy = false;

function setStatus(text: string, tone: '' | 'ok' | 'err' = ''): void {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function setConnected(on: boolean): void {
  connectBtn.hidden = on;
  disconnectBtn.hidden = !on;
  connectBtn.textContent = 'Connect';
}

function refit(): void {
  try { fit.fit(); } catch { /* not visible yet */ }
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
}

/** Worker mode (CONSOLE_TICKETS=worker): the ticket is handed over by the worker, which takes a moment. */
async function waitForTicket(request: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 700));
    const res = await fetch(`/api/console/ticket/${encodeURIComponent(request)}`, { credentials: 'same-origin' });
    const data = (await res.json().catch(() => ({}))) as { ticket?: string; pending?: boolean; error?: string };
    if (res.ok && data.ticket) return data.ticket;
    if (res.status !== 202) throw new Error(failureText(res.status, data.error ?? ''));
  }
  throw new Error('The ticket took too long. Is the worker running?');
}

async function requestTicket(): Promise<string> {
  const res = await fetch(`/api/sites/${siteId}/console`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ cols: term.cols, rows: term.rows }),
  });
  const data = (await res.json().catch(() => ({}))) as { ticket?: string; pending?: string; error?: string; reauth?: boolean; needs_code?: boolean };
  if (res.status === 403 && data.reauth) throw new ReauthRequired(!!data.needs_code);
  if (res.status === 202 && data.pending) return waitForTicket(data.pending);
  if (!res.ok || !data.ticket) throw new Error(failureText(res.status, data.error ?? ''));
  return data.ticket;
}

async function connect(): Promise<void> {
  if (busy || socket) return;
  busy = true;
  connectBtn.disabled = true;
  setStatus('Connecting …');
  term.reset();
  try {
    refit();
    const ws = new WebSocket(wsUrl(location), [protocolFor(await requestTicket())]);
    ws.binaryType = 'arraybuffer';
    socket = ws;
    let ended = false;
    ws.onmessage = (ev: MessageEvent<ArrayBuffer | string>) => {
      if (typeof ev.data !== 'string') { term.write(new Uint8Array(ev.data)); return; }
      let msg: { type?: string; reason?: string; code?: number | null; message?: string };
      try { msg = JSON.parse(ev.data) as typeof msg; } catch { return; }
      if (msg.type === 'ready') { setStatus('Connected', 'ok'); setConnected(true); refit(); term.focus(); }
      if (msg.type === 'error') { ended = true; setStatus(msg.message ?? 'The session could not be started.', 'err'); term.writeln(`\r\n\x1b[31m${msg.message ?? 'Error'}\x1b[0m`); }
      if (msg.type === 'exit') { ended = true; if (msg.reason !== 'error') { setStatus(exitText(msg), msg.reason === 'shell-exited' ? '' : 'err'); term.writeln(`\r\n\x1b[90m[${exitText(msg)}]\x1b[0m`); } }
    };
    ws.onclose = () => {
      socket = null;
      setConnected(false);
      connectBtn.textContent = 'Connect again';
      if (!ended) setStatus('Connection lost', 'err');
    };
    ws.onerror = () => { if (!ended) setStatus('The connection could not be opened. Is a proxy in front of the dashboard blocking WebSockets?', 'err'); };
  } catch (e) {
    if (e instanceof ReauthRequired) showReauth(e.needsCode);
    else setStatus(e instanceof Error ? e.message : 'The console could not be started.', 'err');
  } finally {
    busy = false;
    connectBtn.disabled = false;
  }
}

// typed input is text (UTF-8); onBinary carries raw bytes (mouse reports) as one character per byte
function showReauth(needsCode: boolean): void {
  reauthForm.hidden = false;
  codeWrap.hidden = !needsCode;
  codeEl.required = needsCode;
  reauthMsg.textContent = '';
  setStatus('Confirmation needed');
  (passEl.value ? codeEl : passEl).focus();
  refit();
}

reauthForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  void (async () => {
    reauthMsg.textContent = '';
    const res = await fetch('/api/console/confirm', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ password: passEl.value, code: codeEl.value }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; needs_code?: boolean };
    if (!res.ok) {
      if (data.needs_code) codeWrap.hidden = false;
      reauthMsg.textContent = failureText(res.status, data.error ?? '');
      codeEl.value = '';
      return;
    }
    passEl.value = '';
    codeEl.value = '';
    reauthForm.hidden = true;
    refit();
    void connect();
  })();
});

term.onData((d) => { if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(d)); });
term.onBinary((d) => { if (socket?.readyState === WebSocket.OPEN) socket.send(binaryBytes(d)); });
connectBtn.addEventListener('click', () => { void connect(); });
disconnectBtn.addEventListener('click', () => { socket?.close(1000); });
new ResizeObserver(refit).observe(host);
window.addEventListener('pagehide', () => socket?.close(1000));
refit();
