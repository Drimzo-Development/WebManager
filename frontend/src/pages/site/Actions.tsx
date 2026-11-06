import { useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { ProgressButton } from '../../forms.tsx';
import { waitForJob } from '../../jobs.ts';
import { toast } from '../../runtime.ts';
import { useProgress } from '../../useProgress.ts';

export type SiteAction = 'start' | 'stop' | 'restart' | 'apply';

export function ActionButton({ id, action, icon, label, primary, locked, onDone }: { id: number; action: SiteAction; icon: string; label: string; primary?: boolean; locked?: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const pg = useProgress();
  const run = async () => {
    setBusy(true);
    pg.begin();
    try {
      // the worker runs the job; two minutes are plenty for start/stop/restart
      const r = await api.post<{ job: number }>(`/api/v1/sites/${id}/action`, { action });
      pg.phase('queued');
      pg.alive();
      const job = await waitForJob(r.job, 120_000, 1500, (j) => {
        pg.alive();
        pg.phase(j.status === 'queued' ? 'queued' : 'running');
      });
      onDone();
      if (job) toast(job.title);
      else toast('The task is still running. You can follow it under “Operations → Tasks”.', 'ok');
    } catch (e) {
      onDone();
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      pg.end();
      setBusy(false);
    }
  };
  return <ProgressButton class={`btn${primary ? ' primary' : ''}`} busy={busy} progress={pg.view} disabled={locked} icon={icon} label={label} onClick={() => void run()} />;
}
