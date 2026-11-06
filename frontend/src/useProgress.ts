import { useEffect, useRef, useState } from 'preact/hooks';
import { estimatePercent, IDLE, isStalled, type Phase, type ProgressView } from './progress.ts';

export interface ProgressControl {
  view: ProgressView;
  /** start timing (phase "request") */
  begin: (tauMs?: number) => void;
  /** move on to another phase */
  phase: (p: Phase) => void;
  /** the server answered (a poll, a log line): proof that the connection and the job are alive */
  alive: () => void;
  end: () => void;
}

/** Ticking progress for one running process. The percent never goes backwards while a process runs. */
export function useProgress(): ProgressControl {
  const [view, setView] = useState<ProgressView>(IDLE);
  const st = useRef({ on: false, t0: 0, ph: 'request' as Phase, phAt: 0, alive: 0, tau: 8000, max: 0 });
  const timer = useRef<number | undefined>(undefined);

  const compute = () => {
    const s = st.current;
    const now = Date.now();
    const pct = Math.max(s.max, estimatePercent(s.ph, now - s.phAt, s.tau));
    s.max = pct;
    setView({ active: true, percent: pct, elapsedMs: now - s.t0, stalled: isStalled(now, s.alive), phase: s.ph });
  };

  useEffect(() => () => window.clearInterval(timer.current), []);

  return {
    view,
    begin: (tauMs = 8000) => {
      const now = Date.now();
      st.current = { on: true, t0: now, ph: 'request', phAt: now, alive: now, tau: tauMs, max: 0 };
      window.clearInterval(timer.current);
      timer.current = window.setInterval(compute, 200);
      compute();
    },
    phase: (p) => {
      const s = st.current;
      if (!s.on || s.ph === p) return;
      s.ph = p;
      s.phAt = Date.now();
      // never fall behind what was already shown: start the new phase's curve from the shown value
      compute();
    },
    alive: () => {
      st.current.alive = Date.now();
    },
    end: () => {
      window.clearInterval(timer.current);
      st.current.on = false;
      setView(IDLE);
    },
  };
}
