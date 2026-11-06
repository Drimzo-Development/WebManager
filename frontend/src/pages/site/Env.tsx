import { useEffect, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { Field, Loading, Panel, SaveBar, useSaver } from '../../forms.tsx';
import { formatEnv, parseEnv } from '../../lines.ts';
import { toast, useLoad } from '../../runtime.ts';
import { Rich } from '../../Rich.tsx';

export function EnvSection({ id }: { id: number }) {
  const load = useLoad(() => api.get<{ env: Record<string, string> }>(`/api/sites/${id}/env`));
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    if (load.data) {
      const t = formatEnv(load.data.env);
      setText(t);
      setSaved(t);
    }
  }, [load.data]);
  const save = useSaver(load.reload);
  return (
    <Panel title="Environment variables">
      <Loading load={load}>
        {() => (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              let env: Record<string, string>;
              try {
                env = parseEnv(text);
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'err');
                return;
              }
              void save.run(() => api.put(`/api/sites/${id}/env`, { env }), 'Saved, the container is updated');
            }}
          >
            <Field
              label="NAME=value, one variable per line"
              htmlFor="env-text"
              hint={<Rich text="The values are stored encrypted and passed to the container when saving. Lines starting with {hash} are comments and are not saved. Reserved names such as {path}, {home} or {port} are not allowed." with={{ hash: <code>#</code>, path: <code>PATH</code>, home: <code>HOME</code>, port: <code>PORT</code> }} />}
            >
              <textarea id="env-text" class="input mono tall-edit" rows={16} spellcheck={false} autocomplete="off" value={text} onInput={(e) => setText(e.currentTarget.value)} />
            </Field>
            <SaveBar busy={save.busy} error={save.error} progress={save.progress} label="Save" disabled={text === saved} />
          </form>
        )}
      </Loading>
    </Panel>
  );
}
