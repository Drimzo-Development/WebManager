import { useEffect, useRef, useState } from 'preact/hooks';

interface Ask {
  title: string;
  text: string;
  ok: string;
  danger: boolean;
  resolve: (v: boolean) => void;
}

let open: ((a: Ask) => void) | null = null;

/**
 * Asks for a confirmation in the design of the dashboard (instead of the browser's own dialog) and resolves with the answer.
 * Needs <ConfirmHost /> once in the page; without it the browser dialog is used so that an action is never confirmed silently.
 */
export function askConfirm(title: string, text: string, ok: string, danger = true): Promise<boolean> {
  if (!open) return Promise.resolve(window.confirm(`${title}\n\n${text}`));
  return new Promise<boolean>((resolve) => open?.({ title, text, ok, danger, resolve }));
}

export function ConfirmHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const dlg = useRef<HTMLDialogElement>(null);
  const current = useRef<Ask | null>(null);
  current.current = ask;

  useEffect(() => {
    open = (a) => {
      current.current?.resolve(false); // a second request replaces an open one
      setAsk(a);
    };
    return () => {
      open = null;
    };
  }, []);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (ask && !d.open) d.showModal();
    else if (!ask && d.open) d.close();
  }, [ask]);

  const finish = (v: boolean) => {
    ask?.resolve(v);
    setAsk(null);
  };

  return (
    <dialog ref={dlg} aria-label={ask?.title ?? 'Confirm'} onClose={() => ask && finish(false)}>
      <div class="reveal-body" role="alertdialog" aria-describedby="confirm-text">
        <h2>{ask?.title}</h2>
        <p id="confirm-text" class="muted">{ask?.text}</p>
        <div class="row end">
          <button class="btn ghost" type="button" autofocus onClick={() => finish(false)}>Cancel</button>
          <button class={`btn ${ask?.danger ? 'danger' : 'primary'}`} type="button" onClick={() => finish(true)}>{ask?.ok}</button>
        </div>
      </div>
    </dialog>
  );
}
