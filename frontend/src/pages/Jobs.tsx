import { api } from '../api.ts';
import { relativeTime } from '../format.ts';
import { useLoad } from '../runtime.ts';
import type { Job } from '../types.ts';
import { ErrorNote, Pill } from '../ui.tsx';
import { Loading, Notice, Panel } from '../forms.tsx';
import { FINISHED } from '../jobs.ts';
import { jobSeconds, jobStatus } from '../jobUtil.ts';
import { JobLog } from './site/JobLog.tsx';
import { fill } from '../i18n.ts';

export function JobsPage() {
  const load = useLoad(() => api.get<{ jobs: Job[] }>('/api/v1/jobs?limit=100'), 4000);
  return (
    <main>
      <div class="page-head">
        <div>
          <p class="crumbs muted">Hosting</p>
          <h1>Tasks</h1>
          <p class="muted">Installations, builds, certificates and other work that runs in the background.</p>
        </div>
      </div>
      <Panel title="Last 100 tasks">
        <Loading load={load}>
          {(d) => (
            <div class="scroll-x">
              <table>
                <thead><tr><th>#</th><th>Task</th><th>Status</th><th class="hide-sm">Created</th><th class="hide-sm">Duration</th></tr></thead>
                <tbody>
                  {d.jobs.map((j) => {
                    const st = jobStatus(j.status);
                    const dur = jobSeconds(j);
                    return (
                      <tr key={j.id}>
                        <td><a href={`#/jobs/${j.id}`}>#{j.id}</a></td>
                        <td>{j.title || j.type}{j.error && <span class="err-text small block">{j.error}</span>}</td>
                        <td><Pill tone={st.tone}>{st.label}</Pill></td>
                        <td class="hide-sm muted small">{relativeTime(j.created_at)}</td>
                        <td class="hide-sm muted small">{dur === null ? '–' : `${dur} s`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {d.jobs.length === 0 && <p class="muted empty">No tasks yet. Installations, builds and certificates appear here.</p>}
            </div>
          )}
        </Loading>
      </Panel>
    </main>
  );
}

export function JobPage({ id }: { id: number }) {
  const load = useLoad(() => api.get<{ job: Job }>(`/api/v1/jobs/${id}`), 3000);
  const job = load.data?.job;
  if (load.error && !job) return <main><p class="crumbs muted"><a href="#/jobs">Tasks</a> /</p><ErrorNote message={load.error} onRetry={load.reload} /></main>;
  const st = jobStatus(job?.status ?? 'queued');
  return (
    <main>
      <div class="page-head">
        <div>
          <p class="crumbs muted"><a href="#/jobs">Tasks</a> /</p>
          <h1>{job?.title ? job.title : fill('Task #{id}', { id })}</h1>
          {job && <p class="muted small"><Pill tone={st.tone}>{st.label}</Pill> {'created'} {relativeTime(job.created_at)}{job.finished_at ? fill(', finished {when}', { when: relativeTime(job.finished_at) }) : ''}</p>}
        </div>
        {job?.site_id && <a class="btn" href={`#/sites/${job.site_id}`}>To the website</a>}
      </div>
      {job?.status === 'failed' && <Notice tone="err">{job.error || 'The task failed.'}</Notice>}
      {job?.status === 'succeeded' && <Notice tone="ok">The task completed successfully.</Notice>}
      {job?.status === 'cancelled' && <Notice>The task was cancelled.</Notice>}
      <Panel title="Audit log">
        <JobLog jobId={id} onFinished={(j) => FINISHED.includes(j.status) && load.reload()} />
      </Panel>
    </main>
  );
}
