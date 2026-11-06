'use strict';
/*
 * File operations for the file manager. This script is executed by the agent as a child process
 * with the uid/gid of the website (privilege drop), so it can only touch what that site may touch.
 * In addition every path component is checked with lstat() and symbolic links are refused.
 *
 * argv[2]: JSON { op, root, rel, to?, max?, lines? }
 * stdin  : file content for op=write/upload
 * stdout : JSON result (or raw file content for op=download)
 */
const fs = require('fs');
const path = require('path');

const { ZipWriter } = require('./zipwriter');

const MAX_UPLOAD = 128 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 20000;
const ZIP_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function fail(message, code = 1) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exit(code);
}

function resolveSafe(root, rel, { mustExist = true } = {}) {
  if (typeof rel !== 'string' || rel.includes('\0') || rel.length > 2048) fail('Invalid path');
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) fail('Invalid path');
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch (_) { fail('Project directory not found'); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('Project directory is invalid');
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if (e.code === 'ENOENT') {
        if (mustExist || i < parts.length - 1) fail('Path does not exist');
        break;
      }
      fail(`Access denied: ${e.code}`);
    }
    if (st.isSymbolicLink()) fail('Symbolic links are not allowed');
    if (i < parts.length - 1 && !st.isDirectory()) fail('Path is not a directory');
  }
  return { abs: path.join(root, ...parts), parts };
}

function typeOf(st) {
  if (st.isSymbolicLink()) return 'link';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

/** A single file or folder name of a selection (never a path). */
function cleanName(n) {
  if (typeof n !== 'string' || n === '' || n === '.' || n === '..' || n.length > 255 || /[/\0]/.test(n)) fail('Invalid file name');
  return n;
}

/** Walks the selection (links and special files are skipped, counted in `skipped`); stops at the limits. */
function collectZip(baseAbs, names, excludeAbs) {
  const items = [];
  let total = 0;
  let skipped = 0;
  const add = (zipName, abs, depth) => {
    if (abs === excludeAbs) return; // the archive that is being written
    if (items.length >= ZIP_MAX_ENTRIES) fail('Too many files for one ZIP archive (max. 20,000)');
    if (depth > 64) fail('The folders are nested too deeply');
    let st;
    try { st = fs.lstatSync(abs); } catch (_) { skipped++; return; }
    if (st.isDirectory()) {
      items.push({ zipName, abs, st, dir: true });
      let kids;
      try { kids = fs.readdirSync(abs).sort(); } catch (_) { skipped++; return; }
      for (const k of kids) add(`${zipName}/${k}`, path.join(abs, k), depth + 1);
    } else if (st.isFile()) {
      total += st.size;
      if (total > ZIP_MAX_BYTES) fail('The selection is larger than 2 GB');
      items.push({ zipName, abs, st, dir: false });
    } else skipped++;
  };
  for (const n of names) add(n, path.join(baseAbs, n), 0);
  return { items, total, skipped };
}

/**
 * op=zip: packs `names` (entries of the folder `rel`) into a ZIP archive. With `to` the archive is written into the project
 * (the file must not exist yet) and the result is JSON; without it the archive is streamed to stdout (download).
 */
async function runZip(req) {
  const { root, rel = '' } = req;
  const names = Array.isArray(req.names) ? req.names : [];
  if (names.length === 0 || names.length > 1000) fail('Nothing is selected');
  const base = resolveSafe(root, rel);
  if (!fs.lstatSync(base.abs).isDirectory()) fail('Not a directory');
  const uniq = [...new Set(names.map(cleanName))];
  for (const n of uniq) resolveSafe(root, [rel, n].filter(Boolean).join('/'));
  let target = null;
  if (req.to) {
    if (!/\.zip$/i.test(req.to)) fail('The name of the archive must end with .zip');
    target = resolveSafe(root, req.to, { mustExist: false });
    let exists = true;
    try { fs.lstatSync(target.abs); } catch (_) { exists = false; }
    if (exists) fail('Target already exists');
  }
  const plan = collectZip(base.abs, uniq, target ? target.abs : null);
  if (plan.items.length === 0) fail('Nothing to compress');
  let fd = null;
  let out = process.stdout;
  if (target) {
    const sf = fs.statfsSync(root);
    if (sf.bavail * sf.bsize < plan.total * 1.02 + 1024 * 1024) fail('There is not enough free disk space for the archive');
    try { fd = fs.openSync(target.abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o640); } catch (e) { fail(`The archive cannot be created: ${e.code}`); }
    out = fs.createWriteStream(null, { fd, autoClose: false });
  }
  const zip = new ZipWriter(out);
  try {
    for (const it of plan.items) {
      if (it.dir) {
        await zip.addDir(it.zipName, it.st.mtimeMs, it.st.mode);
        continue;
      }
      let ffd;
      try { ffd = fs.openSync(it.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (_) { plan.skipped++; continue; }
      try { await zip.addFile(it.zipName, ffd, it.st.mtimeMs, it.st.mode); } finally { fs.closeSync(ffd); }
    }
    const size = await zip.finish();
    if (target) {
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      fs.closeSync(fd);
      process.stdout.write(JSON.stringify({ ok: true, size, count: plan.items.length, skipped: plan.skipped }));
    }
  } catch (e) {
    if (!target) process.exit(2); // the download has already started: the truncated archive tells the client
    try { out.destroy(); fs.closeSync(fd); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(target.abs); } catch (_) { /* ignore */ }
    fail(`The archive could not be created: ${e.code || e.message}`);
  }
}

function main() {
  let req;
  try { req = JSON.parse(process.argv[2]); } catch (_) { fail('Invalid request'); }
  const { op, root, rel = '' } = req;
  process.umask(0o027);

  switch (op) {
    case 'list': {
      const { abs } = resolveSafe(root, rel);
      const st = fs.lstatSync(abs);
      if (!st.isDirectory()) fail('Not a directory');
      const entries = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 5000).map((d) => {
        let s;
        try { s = fs.lstatSync(path.join(abs, d.name)); } catch (_) { return null; }
        return { name: d.name, type: typeOf(s), size: s.size, mtime: Math.floor(s.mtimeMs / 1000), mode: (s.mode & 0o777).toString(8) };
      }).filter(Boolean);
      entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
      process.stdout.write(JSON.stringify({ ok: true, entries }));
      break;
    }
    case 'read': {
      const { abs } = resolveSafe(root, rel);
      const st = fs.lstatSync(abs);
      if (!st.isFile()) fail('Not a file');
      const max = Math.min(req.max || 2 * 1024 * 1024, 5 * 1024 * 1024);
      if (st.size > max) fail(`File is larger than ${Math.floor(max / 1024)} KB and cannot be opened in the editor`);
      const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const buf = fs.readFileSync(fd);
      fs.closeSync(fd);
      const binary = buf.includes(0);
      process.stdout.write(JSON.stringify({ ok: true, size: st.size, binary, content: binary ? '' : buf.toString('utf8') }));
      break;
    }
    case 'tail': {
      const { abs } = resolveSafe(root, rel);
      const st = fs.lstatSync(abs);
      if (!st.isFile()) fail('Not a file');
      const lines = Math.min(Math.max(req.lines || 200, 1), 2000);
      const len = Math.min(st.size, 512 * 1024);
      const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const out = buf.toString('utf8').split('\n').slice(-lines - 1).join('\n');
      process.stdout.write(JSON.stringify({ ok: true, content: out }));
      break;
    }
    case 'write':
    case 'upload': {
      if (!rel) fail('Path missing');
      const { abs } = resolveSafe(root, rel, { mustExist: false });
      const limit = op === 'write' ? 10 * 1024 * 1024 : MAX_UPLOAD;
      let fd;
      try {
        fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o640);
      } catch (e) { fail(`File cannot be written: ${e.code}`); }
      let size = 0;
      process.stdin.on('data', (c) => {
        size += c.length;
        if (size > limit) { try { fs.closeSync(fd); fs.unlinkSync(abs); } catch (_) { /* ignore */ } fail('File is too large'); }
        fs.writeSync(fd, c);
      });
      process.stdin.on('end', () => {
        fs.closeSync(fd);
        process.stdout.write(JSON.stringify({ ok: true, size }));
      });
      break;
    }
    case 'download': {
      const { abs } = resolveSafe(root, rel);
      const st = fs.lstatSync(abs);
      if (!st.isFile()) fail('Not a file');
      const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      fs.createReadStream(null, { fd }).pipe(process.stdout);
      break;
    }
    case 'zip':
      runZip(req).catch((e) => fail(`Error: ${e.code || e.message}`));
      break;
    case 'mkdir': {
      if (!rel) fail('Path missing');
      const { abs } = resolveSafe(root, rel, { mustExist: false });
      if (fs.existsSync(abs)) fail('Already exists');
      fs.mkdirSync(abs, { mode: 0o750 });
      process.stdout.write(JSON.stringify({ ok: true }));
      break;
    }
    case 'rename': {
      if (!rel || !req.to) fail('Path missing');
      const a = resolveSafe(root, rel);
      const b = resolveSafe(root, req.to, { mustExist: false });
      if (fs.existsSync(b.abs)) fail('Target already exists');
      fs.renameSync(a.abs, b.abs);
      process.stdout.write(JSON.stringify({ ok: true }));
      break;
    }
    case 'copy': {
      if (!rel || !req.to) fail('Path missing');
      const a = resolveSafe(root, rel);
      const b = resolveSafe(root, req.to, { mustExist: false });
      if (fs.existsSync(b.abs)) fail('Target already exists');
      const srcPrefix = a.abs + path.sep;
      if (b.abs === a.abs || b.abs.startsWith(srcPrefix)) fail('A folder cannot be copied into itself');
      let count = 0;
      const copyRec = (src, dst) => {
        if (++count > 20000) fail('Too many files to copy');
        const st = fs.lstatSync(src);
        if (st.isSymbolicLink()) fail('Symbolic links are not allowed');
        if (st.isDirectory()) {
          fs.mkdirSync(dst, { mode: 0o750 });
          for (const n of fs.readdirSync(src)) copyRec(path.join(src, n), path.join(dst, n));
        } else if (st.isFile()) {
          fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(dst, st.mode & 0o750 | 0o640);
        } else fail('Unsupported file type');
      };
      copyRec(a.abs, b.abs);
      process.stdout.write(JSON.stringify({ ok: true, count }));
      break;
    }
    case 'delete': {
      if (!rel || rel.split('/').filter((p) => p && p !== '.').length === 0) fail('The project directory itself cannot be deleted');
      const { abs } = resolveSafe(root, rel);
      fs.rmSync(abs, { recursive: true, force: false });
      process.stdout.write(JSON.stringify({ ok: true }));
      break;
    }
    default:
      fail('Unknown operation');
  }
}

if (require.main === module) {
  try { main(); } catch (e) { fail(`Error: ${e.code || e.message}`); }
}

module.exports = { resolveSafe };
