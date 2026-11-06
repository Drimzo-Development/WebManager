'use strict';
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

let ready = false;
function ensure() {
  if (ready) return;
  try {
    fs.mkdirSync(path.dirname(config.AUDIT_LOG), { recursive: true, mode: 0o750 });
  } catch (_) { /* ignore, falls back to stdout only */ }
  ready = true;
}

/** Appends a JSON line to the audit log and mirrors it to stdout. Never logs secrets. */
function audit(event, fields = {}) {
  ensure();
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  try { fs.appendFileSync(config.AUDIT_LOG, line + '\n', { mode: 0o640 }); } catch (_) { /* ignore */ }
  process.stdout.write(line + '\n');
}

module.exports = { audit };
