import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { formatBytes, relativeTime } from '../../format.ts';
import { joinPath, parentPath, pathTrail, rangeBetween, validFolder, validName } from '../../lines.ts';
import { toast, useLoad } from '../../runtime.ts';
import { ErrorNote, Icon, Skeleton } from '../../ui.tsx';
import { ProgressButton } from '../../forms.tsx';
import { fill } from '../../i18n.ts';
import { askConfirm } from '../../confirm.tsx';

interface Entry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number;
}

interface FileContent {
  size: number;
  binary: boolean;
  content: string;
}

type Ask = { kind: 'file' | 'dir' | 'rename' | 'copy' | 'zip' | 'move'; entry?: Entry; value: string } | null;

interface BatchAnswer {
  results: { name: string; ok: boolean; error?: string }[];
}

const MAX_DIRECT_ZIP = 100;

const q = (path: string) => encodeURIComponent(path);
const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));

const ASK_TITLE = { file: 'New file', dir: 'New folder', rename: 'Rename', copy: 'Copy as', zip: 'Compress to ZIP', move: 'Move to' } as const;
const ASK_LABEL = { file: 'Name', dir: 'Name', rename: 'Name', copy: 'Name', zip: 'Name of the archive', move: 'Target folder (empty = the website root)' } as const;

// ---------------------------------------------------------------- editor
function Editor({ id, path, onClose }: { id: number; path: string; onClose: () => void }) {
  const load = useLoad(() => api.get<FileContent>(`/api/sites/${id}/files/content?path=${q(path)}`));
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (load.data) {
      setText(load.data.content);
      setSaved(load.data.content);
    }
  }, [load.data]);
  const dirty = text !== saved;

  async function save() {
    setBusy(true);
    try {
      await api.put(`/api/sites/${id}/files/content?path=${q(path)}`, { content: text });
      setSaved(text);
      toast(fill('{name} saved', { name: path.split('/').pop() }));
    } catch (e) {
      toast(failure(e), 'err');
    } finally {
      setBusy(false);
    }
  }
  const close = async () => {
    if (!dirty || (await askConfirm('Discard changes?', 'Discard unsaved changes?', 'Discard'))) onClose();
  };

  // warn before leaving the page with unsaved changes
  useEffect(() => {
    if (!dirty) return;
    const on = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', on);
    return () => removeEventListener('beforeunload', on);
  }, [dirty]);

  const name = path.split('/').pop() ?? path;
  return (
    <section class="card card-pad">
      <div class="card-head">
        <div>
          <h2 class="mono" translate={false}>{path}{dirty && <span class="dirty" title="Unsaved changes"> ●</span>}</h2>
          {load.data && <span class="muted small">{formatBytes(load.data.size)}</span>}
        </div>
        <div class="row">
          <a class="btn ghost" href={`/api/sites/${id}/files/download?path=${q(path)}`} download={name}><Icon name="archive" small />Download</a>
          <button class="btn ghost" onClick={close}>Close</button>
          <ProgressButton class="btn primary" busy={busy} disabled={!dirty || !load.data || load.data.binary} onClick={() => void save()} label="Save" />
        </div>
      </div>
      {load.error && <ErrorNote message={load.error} onRetry={load.reload} />}
      {load.data?.binary && <ErrorNote message="This is a binary file and cannot be edited in the editor. Download it instead." />}
      {load.data && !load.data.binary && (
        <textarea
          class="input mono editor"
          spellcheck={false}
          aria-label={fill('Contents of {name}', { name })}
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              if (dirty && !busy) void save();
            }
          }}
        />
      )}
      {!load.data && !load.error && <Skeleton lines={5} />}
      <p class="muted small" style={{ marginTop: 'var(--sp-2)' }}>Ctrl+S saves. Files up to 2 MB can be edited.</p>
    </section>
  );
}

// ---------------------------------------------------------------- file manager
export function FilesSection({ id }: { id: number }) {
  const [dir, setDir] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const lastClick = useRef(-1);
  const list = useLoad(() => api.get<{ entries: Entry[] }>(`/api/sites/${id}/files?path=${q(dir)}`));
  const dlg = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    list.reload();
    setSel(new Set());
    lastClick.current = -1;
  }, [dir]);
  // what was deleted, moved or renamed is no longer selected
  useEffect(() => {
    if (!list.data) return;
    const names = new Set(list.data.entries.map((x) => x.name));
    setSel((prev) => (Array.from(prev).every((n) => names.has(n)) ? prev : new Set(Array.from(prev).filter((n) => names.has(n)))));
  }, [list.data]);
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (ask && !d.open) d.showModal();
    else if (!ask && d.open) d.close();
  }, [ask]);

  const run = async (fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      list.reload();
      return true;
    } catch (e) {
      toast(failure(e), 'err');
      return false;
    } finally {
      setBusy(false);
    }
  };

  async function upload(files: FileList | File[]) {
    const all = Array.from(files);
    if (all.length === 0) return;
    const body = new FormData();
    all.forEach((f) => body.append('file[]', f));
    setBusy(true);
    try {
      const r = await api.post<{ results: { name: string; ok: boolean; error?: string }[] }>(`/api/sites/${id}/files/upload?path=${q(dir)}`, body);
      const bad = r.results.filter((x) => !x.ok);
      if (bad.length === 0) toast(fill('{n} {what} uploaded', { n: r.results.length, what: r.results.length === 1 ? 'File' : 'Files' }));
      else toast(bad.map((b) => `${b.name}: ${b.error ?? 'Error'}`).join(' · '), 'err');
      list.reload();
    } catch (e) {
      toast(failure(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  function submitAsk(e: Event) {
    e.preventDefault();
    if (!ask) return;
    const a = ask;
    if (a.kind === 'move') {
      const to = a.value.trim().replace(/^\/+|\/+$/g, '');
      if (!validFolder(to)) return toast('Invalid folder: a path inside the website without “..”.', 'err');
      setAsk(null);
      void bulkMove(to);
      return;
    }
    const name = a.value.trim();
    if (!validName(name)) return toast('Invalid name: no “/”, not empty, not “.” or “..”.', 'err');
    const target = joinPath(dir, name);
    setAsk(null);
    if (a.kind === 'zip') {
      void compress(name);
      return;
    }
    if (a.kind === 'file') void run(() => api.put(`/api/sites/${id}/files/content?path=${q(target)}`, { content: '' }), fill('{name} created', { name })).then((ok) => ok && setOpen(target));
    else if (a.kind === 'dir') void run(() => api.post(`/api/sites/${id}/files/mkdir`, { path: target }), fill('Folder {name} created', { name }));
    else if (a.kind === 'rename' && a.entry) void run(() => api.post(`/api/sites/${id}/files/rename`, { path: joinPath(dir, a.entry!.name), to: target }), 'Renamed');
    else if (a.kind === 'copy' && a.entry) void run(() => api.post(`/api/sites/${id}/files/copy`, { path: joinPath(dir, a.entry!.name), to: target }), 'Copied');
  }

  const selectable = (list.data?.entries ?? []).filter((x) => x.type === 'dir' || x.type === 'file');

  function toggle(name: string, shift: boolean) {
    const idx = selectable.findIndex((x) => x.name === name);
    setSel((prev) => {
      const next = new Set(prev);
      if (shift && lastClick.current >= 0) {
        // the whole range gets the state the clicked row is going to have
        const on = !prev.has(name);
        for (const x of rangeBetween(selectable, lastClick.current, idx)) (on ? next.add(x.name) : next.delete(x.name));
      } else if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    lastClick.current = idx;
  }

  const allSelected = selectable.length > 0 && selectable.every((x) => sel.has(x.name));
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(selectable.map((x) => x.name)));
  const archiveHref = `/api/sites/${id}/files/archive?path=${q(dir)}${Array.from(sel).map((n) => `&n[]=${q(n)}`).join('')}`;

  async function compress(name: string) {
    const names = Array.from(sel);
    setBusy(true);
    try {
      const r = await api.post<{ name: string; size: number; count: number; skipped: number }>(`/api/sites/${id}/files/zip`, { dir, names, name });
      const note = r.skipped > 0 ? fill(' ({n} links or special files left out)', { n: r.skipped }) : '';
      toast(fill('{name} created ({size})', { name: r.name, size: formatBytes(r.size) }) + note);
      setSel(new Set());
      list.reload();
    } catch (e) {
      toast(failure(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  /** One request for several files; reports the files that failed. */
  async function batch(body: Record<string, unknown>, okText: string) {
    setBusy(true);
    try {
      const r = await api.post<BatchAnswer>(`/api/sites/${id}/files/batch`, { dir, names: Array.from(sel), ...body });
      const bad = r.results.filter((x) => !x.ok);
      if (bad.length === 0) toast(okText);
      else toast(bad.slice(0, 3).map((b) => `${b.name}: ${b.error ?? 'Error'}`).join(' · ') + (bad.length > 3 ? fill(' … and {n} more', { n: bad.length - 3 }) : ''), 'err');
      setSel(new Set());
      list.reload();
    } catch (e) {
      toast(failure(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  const bulkMove = (to: string) => batch({ action: 'move', to }, fill('{n} items moved', { n: sel.size }));

  async function bulkDelete() {
    if (await askConfirm('Delete permanently?', fill('Delete {n} selected items permanently? Folders are deleted with everything in them.', { n: sel.size }), 'Delete')) void batch({ action: 'delete' }, fill('{n} items deleted', { n: sel.size }));
  }

  function startZip() {
    const names = Array.from(sel);
    setAsk({ kind: 'zip', value: `${names.length === 1 ? names[0] : (dir.split('/').pop() || 'website')}.zip` });
  }

  async function remove(e: Entry) {
    const what = e.type === 'dir' ? fill('Folder “{name}” with everything in it,', { name: e.name }) : `„${e.name}“`;
    if (await askConfirm('Delete permanently?', fill('Delete {what} permanently?', { what }), 'Delete')) void run(() => api.del(`/api/sites/${id}/files?path=${q(joinPath(dir, e.name))}`), fill('{name} deleted', { name: e.name }));
  }

  if (open !== null) return <Editor id={id} path={open} onClose={() => { setOpen(null); list.reload(); }} />;

  const entries = list.data?.entries ?? [];
  const trail = pathTrail(dir);
  return (
    <section
      class={`card card-pad fm${drag ? ' dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer?.files ?? []); }}
    >
      <div class="card-head">
        <nav class="crumbs-path" aria-label="Path">
          <button class="link" onClick={() => setDir('')}>Website</button>
          {trail.map((t) => <span key={t.path}> / <button class="link" translate={false} onClick={() => setDir(t.path)}>{t.name}</button></span>)}
        </nav>
        <div class="row">
          <button class="btn" disabled={busy} onClick={() => setAsk({ kind: 'file', value: '' })}><Icon name="plus" small />File</button>
          <button class="btn" disabled={busy} onClick={() => setAsk({ kind: 'dir', value: '' })}><Icon name="folder" small />Folder</button>
          <button class="btn" disabled={busy} onClick={() => picker.current?.click()}><Icon name="archive" small />Upload</button>
          <button class="btn ghost icon" aria-label="Refresh" onClick={list.reload}><Icon name="refresh" small /></button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => { void upload(e.currentTarget.files ?? []); e.currentTarget.value = ''; }} />
        </div>
      </div>
      {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}
      {sel.size > 0 && (
        <div class="bulkbar" role="toolbar" aria-label="Selection">
          <span class="strong">{fill('{n} selected', { n: sel.size })}</span>
          {sel.size <= MAX_DIRECT_ZIP ? (
            <a class="btn" href={archiveHref} download><Icon name="archive" small />Download as ZIP</a>
          ) : (
            <span class="muted small" title={fill('A direct download takes at most {n} items; compress them first.', { n: MAX_DIRECT_ZIP })}>{fill('Direct download: at most {n} items', { n: MAX_DIRECT_ZIP })}</span>
          )}
          <button class="btn" disabled={busy} onClick={startZip}><Icon name="layers" small />Compress to ZIP</button>
          <button class="btn" disabled={busy} onClick={() => setAsk({ kind: 'move', value: dir })}><Icon name="arrow-right" small />Move</button>
          <button class="btn danger" disabled={busy} onClick={() => void bulkDelete()}><Icon name="trash" small />Delete</button>
          <button class="link" onClick={() => setSel(new Set())}>Clear selection</button>
        </div>
      )}
      <div class="scroll-x">
        <table>
          <thead><tr><th class="sel"><input type="checkbox" checked={allSelected} disabled={selectable.length === 0} onChange={toggleAll} aria-label="Select all" /></th><th>Name</th><th class="num">Size</th><th class="hide-sm">Modified</th><th><span class="sr">Actions</span></th></tr></thead>
          <tbody>
            {dir !== '' && (
              <tr><td colSpan={5}><button class="link" onClick={() => setDir(parentPath(dir))}><Icon name="chevron-right" small /> {'.. (one level up)'}</button></td></tr>
            )}
            {entries.map((e) => (
              <tr key={e.name} class={sel.has(e.name) ? 'selected' : undefined}>
                <td class="sel">
                  {(e.type === 'dir' || e.type === 'file') && (
                    <input
                      type="checkbox"
                      checked={sel.has(e.name)}
                      aria-label={fill('Select {name}', { name: e.name })}
                      onClick={(ev) => { ev.preventDefault(); toggle(e.name, ev.shiftKey); }}
                    />
                  )}
                </td>
                <td>
                  <button class="file-name" onClick={() => (e.type === 'dir' ? setDir(joinPath(dir, e.name)) : e.type === 'file' ? setOpen(joinPath(dir, e.name)) : undefined)} disabled={e.type !== 'dir' && e.type !== 'file'} title={e.type === 'link' ? 'Symbolic link' : undefined}>
                    <Icon name={e.type === 'dir' ? 'folder' : 'file-text'} small />
                    <span translate={false}>{e.name}</span>
                    {e.type === 'link' && <span class="muted small"> {'(link)'}</span>}
                  </button>
                </td>
                <td class="num muted small">{e.type === 'dir' ? '' : formatBytes(e.size)}</td>
                <td class="hide-sm muted small">{relativeTime(new Date(e.mtime * 1000).toISOString())}</td>
                <td class="num">
                  <div class="row end" style={{ margin: 0 }}>
                    {e.type === 'file' && <a class="btn ghost icon" href={`/api/sites/${id}/files/download?path=${q(joinPath(dir, e.name))}`} download={e.name} aria-label={fill('Download {name}', { name: e.name })} title="Download"><Icon name="archive" small /></a>}
                    <button class="btn ghost icon" aria-label={fill('Rename {name}', { name: e.name })} title="Rename" onClick={() => setAsk({ kind: 'rename', entry: e, value: e.name })}><Icon name="edit" small /></button>
                    <button class="btn ghost icon" aria-label={fill('Copy {name}', { name: e.name })} title="Copy" onClick={() => setAsk({ kind: 'copy', entry: e, value: fill('{name}-copy', { name: e.name }) })}><Icon name="layers" small /></button>
                    <button class="btn ghost icon" aria-label={fill('Delete {name}', { name: e.name })} title="Delete" onClick={() => remove(e)}><Icon name="trash" small /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data && entries.length === 0 && <p class="muted empty">This folder is empty. Drag files here to upload them.</p>}
      </div>
      <p class="muted small" style={{ marginTop: 'var(--sp-3)' }}>Drag files onto this area to upload them to the current folder (up to 128 MB per file). Tick several files to download, compress, move or delete them together. Hold Shift to select a range.</p>

      <dialog ref={dlg} aria-label={ask ? ASK_TITLE[ask.kind] : 'Name'} onClose={() => setAsk(null)}>
        <form class="reveal-body" onSubmit={submitAsk}>
          <h2>{ask ? ASK_TITLE[ask.kind] : ''}</h2>
          <div class="field">
            <label for="fm-name">{ask ? ASK_LABEL[ask.kind] : 'Name'}</label>
            <input id="fm-name" class="input mono" autocomplete="off" spellcheck={false} required={ask?.kind !== 'move'} value={ask?.value ?? ''} onInput={(e) => ask && setAsk({ ...ask, value: e.currentTarget.value })} />
          </div>
          <div class="row end">
            <button class="btn ghost" type="button" onClick={() => setAsk(null)}>Cancel</button>
            <button class="btn primary" type="submit">OK</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
