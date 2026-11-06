import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

interface Ask {
  title: string;
  text?: ComponentChildren;
  ok: string;
  /** extra text field above the password (for example a name) */
  field?: { label: string; placeholder?: string };
  resolve: (v: { password: string; field: string } | null) => void;
}

/**
 * Promise based "enter your password" dialog. Second-factor changes need the current password; the dialog keeps it out of
 * the page (never in a URL or a DOM attribute) and returns it only to the caller.
 */
export function usePasswordPrompt() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const dlg = useRef<HTMLDialogElement>(null);
  const [pw, setPw] = useState('');
  const [extra, setExtra] = useState('');
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (ask && !d.open) {
      setPw('');
      setExtra('');
      d.showModal();
    } else if (!ask && d.open) d.close();
  }, [ask]);

  const finish = (v: { password: string; field: string } | null) => {
    ask?.resolve(v);
    setAsk(null);
  };

  const dialog = (
    <dialog ref={dlg} aria-label={ask?.title ?? 'Password'} onClose={() => ask && finish(null)}>
      <form
        class="reveal-body"
        autocomplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          finish({ password: pw, field: extra });
        }}
      >
        <h2>{ask?.title}</h2>
        {ask?.text && <p class="muted small">{ask.text}</p>}
        {ask?.field && (
          <div class="field">
            <label for="pp-extra">{ask.field.label}</label>
            <input id="pp-extra" class="input" maxLength={100} placeholder={ask.field.placeholder} value={extra} onInput={(e) => setExtra(e.currentTarget.value)} required />
          </div>
        )}
        <div class="field">
          <label for="pp-pw">Current password</label>
          <input id="pp-pw" class="input" type="password" autocomplete="current-password" required autofocus value={pw} onInput={(e) => setPw(e.currentTarget.value)} />
        </div>
        <div class="row end">
          <button class="btn ghost" type="button" onClick={() => finish(null)}>Cancel</button>
          <button class="btn primary" type="submit">{ask?.ok}</button>
        </div>
      </form>
    </dialog>
  );

  const prompt = (title: string, text: ComponentChildren, ok: string, field?: Ask['field']) =>
    new Promise<{ password: string; field: string } | null>((resolve) => setAsk({ title, text, ok, field, resolve }));
  return { dialog, prompt };
}
