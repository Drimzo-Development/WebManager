import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../../api.ts';
import { FINISHED } from '../../jobs.ts';
import { toast } from '../../runtime.ts';
import type { Job } from '../../types.ts';
import { progressText } from '../../progress.ts';
import { Pill } from '../../ui.tsx';
import { useProgress } from '../../useProgress.ts';

interface LogAnswer {
  lines: { id: number; line: string }[];
  status: string;
  finished: boolean;
  job: Job;
}

const LABEL: Record<string, string> = { queued: 'queued', running: 'running', cancelling: 'being cancelled', succeeded: 'erledigt', failed: 'fehlgeschlagen', cancelled: 'abgebrochen' };

/** Follows a job: new log lines are fetched every second until it ends (the worker writes them, the page never holds a long request). */
export function JobLog({ jobId, onFinished }: { jobId: number; onFinished?: (job: Job) => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const box = useRef<HTMLPreElement>(null);
  const done = useRef(onFinished);
  done.current = onFinished;
  const pg = useProgress();
  const pgRef = useRef(pg);
  pgRef.current = pg;

  useEffect(() => {
    let alive = true;
    let after = 0;
    let timer: number | undefined;
    setLines([]);
    setJob(null);
    setError('');
    pgRef.current.begin(20_000);
    const tick = async () => {
      try {
        const r = await api.get<LogAnswer>(`/api/v1/jobs/${jobId}/logs?after=${after}`);
        if (!alive) return;
        if (r.lines.length > 0) {
          after = r.lines[r.lines.length - 1]!.id;
          setLines((l) => [...l, ...r.lines.map((x) => x.line)]);
        }
        setJob(r.job);
        pgRef.current.alive();
        pgRef.current.phase(r.job.status === 'queued' ? 'queued' : 'running');
        if (r.finished || FINISHED.includes(r.job.status)) {
          pgRef.current.end();
          done.current?.(r.job);
          return;
        }
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      timer = window.setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
      pgRef.current.end();
    };
  }, [jobId]);

  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const status = job?.status ?? 'queued';
  const running = ['queued', 'running'].includes(status);
  return (
    <div class="joblog">
      <div class="row">
        <span class="small muted">{'Task #'}{jobId}</span>
        <Pill tone={status === 'succeeded' ? 'ok' : status === 'failed' ? 'err' : running ? 'warn' : ''}>{LABEL[status] ?? status}</Pill>
        {running && (
          <button
            class="btn ghost"
            onClick={() => api.post(`/api/v1/jobs/${jobId}/cancel`).then(() => toast('Cancellation requested'), (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'err'))}
          >Cancel</button>
        )}
        <a class="small" href={`#/jobs/${jobId}`}>Details</a>
      </div>
      {running && pg.view.active && (
        <div class={`jprog${pg.view.stalled ? ' stalled' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pg.view.percent)} aria-label="Progress of the task (estimated)">
          <div class="jprog-track"><div class="jprog-fill" style={{ width: `${pg.view.percent}%` }} /></div>
          <span class="small muted">{progressText(pg.view)}{pg.view.stalled ? ' · no answer from the server, the task may still be running' : ''}</span>
        </div>
      )}
      {!running && job && <div class={`jprog done ${status === 'succeeded' ? 'ok' : 'bad'}`}><div class="jprog-track"><div class="jprog-fill" style={{ width: '100%' }} /></div></div>}
      {error && <p class="err-text small">{error}</p>}
      <pre ref={box} class="log compact" tabIndex={0} aria-label="Output of the task" aria-live="off">{lines.length ? lines.join('\n') : running ? 'Waiting to start …' : '(no output)'}</pre>
    </div>
  );
}
