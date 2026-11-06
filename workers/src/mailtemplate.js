'use strict';
// HTML mails in the dashboard's look (table layout and inline styles: the only thing mail clients render reliably).
const BRAND = '#2f6fe4';
const BG = '#f3f5f8';
const LINE = '#dfe3ea';
const TEXT = '#46505f';
const STRONG = '#1a2230';
const MUTED = '#6b7686';
const KINDS = {
  ok: { color: '#059669', bg: '#ecfdf5', label: 'Done' },
  warn: { color: '#d97706', bg: '#fffbeb', label: 'Warning' },
  error: { color: '#dc2626', bg: '#fef2f2', label: 'Incident' },
  info: { color: BRAND, bg: '#eaf0fe', label: 'Information' },
};
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Plain text -> HTML: blank line = paragraph, "• " lines = bullet list, single line breaks are kept. */
function body(text) {
  return String(text).trim().split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => l.startsWith('• '))) {
      return `<ul style="margin:0 0 16px;padding-left:20px;">${lines.map((l) => `<li style="margin:0 0 6px;">${esc(l.slice(2))}</li>`).join('')}</ul>`;
    }
    return `<p style="margin:0 0 16px;">${lines.map(esc).join('<br>')}</p>`;
  }).join('');
}

/**
 * @param {{ title: string, text: string, kind?: 'ok'|'warn'|'error'|'info', facts?: Array<[string,string]>, link?: {url:string,label?:string}, logo?: boolean, brand?: string }} o
 * `logo`: the message carries the logo as inline attachment with Content-ID "logo".
 */
function renderMail(o) {
  const k = KINDS[o.kind] || KINDS.info;
  const facts = (o.facts || []).filter((f) => f && f[1] !== undefined && f[1] !== null && f[1] !== '');
  const factRows = facts.map(([a, b]) => `<tr><td style="padding:8px 16px 8px 0;border-top:1px solid ${LINE};color:${MUTED};font-size:13px;white-space:nowrap;vertical-align:top;">${esc(a)}</td><td style="padding:8px 0;border-top:1px solid ${LINE};color:${TEXT};font-size:14px;font-weight:600;">${esc(b)}</td></tr>`).join('');
  const logo = o.logo
    ? '<img src="cid:logo" width="32" height="32" alt="" style="display:block;border:0;border-radius:7px;">'
    : '';
  const button = o.link && /^https?:\/\//.test(o.link.url)
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;"><tr><td style="background:${BRAND};border-radius:8px;"><a href="${esc(o.link.url)}" style="display:inline-block;padding:10px 20px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">${esc(o.link.label || 'Open in the WebManager')}</a></td></tr></table>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;font-family:${FONT};">
<tr><td style="padding:0 4px 14px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>${logo ? `<td style="padding-right:10px;vertical-align:middle;">${logo}</td>` : ''}<td style="vertical-align:middle;color:${STRONG};font-size:15px;font-weight:700;line-height:1.2;">${esc(o.brand || 'Drimzo Development')}<span style="font-weight:400;color:${MUTED};"> &middot; webmanager</span></td></tr></table>
</td></tr>
<tr><td style="background:#ffffff;border:1px solid ${LINE};border-top:3px solid ${k.color};border-radius:10px;padding:26px 26px 22px;color:${TEXT};font-size:15px;line-height:1.55;">
<div style="color:${k.color};font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;">${esc(k.label)}</div>
<h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;color:${STRONG};">${esc(o.title)}</h1>
${body(o.text)}
${factRows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:4px 0 8px;border-bottom:1px solid ${LINE};">${factRows}</table>` : ''}
${button}
</td></tr>
<tr><td style="padding:14px 4px 0;color:${MUTED};font-size:12px;line-height:1.5;">Automatic message from ${esc(o.brand || 'Drimzo Development')}. You choose which messages you receive under “System &rarr; Email &amp; notifications”.</td></tr>
</table></td></tr></table>
</body></html>`;
}

module.exports = { renderMail, esc };
