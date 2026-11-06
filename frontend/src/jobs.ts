import { api } from './api.ts';
import type { Job } from './types.ts';
import { fill } from './i18n.ts';

export const FINISHED = ['succeeded', 'failed', 'cancelled'];

/**
 * Waits until a job ends. Resolves with the finished job, throws when it failed or was cancelled.
 * Gives up quietly after `maxMs` (the job keeps running; the caller can tell the user where to look).
 * `onUpdate` sees every answer of the server, so a caller can show progress and that the job is still being watched.
 */
export async function waitForJob(id: number, maxMs = 180_000, everyMs = 1200, onUpdate?: (job: Job) => void): Promise<Job | null> {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, everyMs));
    const { job } = await api.get<{ job: Job }>(`/api/v1/jobs/${id}`);
    onUpdate?.(job);
    if (FINISHED.includes(job.status)) {
      if (job.status !== 'succeeded') throw new Error(fill('{title}: {v}. Details under “Tasks”.', { title: job.title, v: job.status === 'failed' ? 'failed' : 'cancelled' }));
      return job;
    }
  }
  return null;
}
