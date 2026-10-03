// Runs waiting at a `pause` step. The runner parks here; the routes resolve
// the wait with Resume / Abort; the UI reads the list to show the buttons.
// In-memory on purpose: a paused run cannot outlive the server process (its
// browser session wouldn't either).

export type PauseOutcome = 'resumed' | 'aborted' | 'timeout';

export interface PausedRun {
  runId: number;
  scenarioId: number;
  position: number;
  label: string | null;
  since: string;
  timeoutMs: number;
  /** When the timeout will abort the run, absolute. */
  deadline: string;
}

interface Entry extends PausedRun {
  settle: (outcome: PauseOutcome) => void;
}

const paused = new Map<number, Entry>();

export function pausedRun(runId: number): PausedRun | null {
  const e = paused.get(runId);
  if (!e) return null;
  const { settle: _settle, ...info } = e;
  return info;
}

export function listPaused(): PausedRun[] {
  return [...paused.values()].map(({ settle: _settle, ...info }) => info);
}

/**
 * Park a run until resume/abort/timeout. `keepAlive` runs every
 * `keepAliveMs` while waiting — the browser daemon shuts itself down after
 * AGENT_BROWSER_IDLE_TIMEOUT_MS without commands (5 min here), which would
 * silently swap the paused page for a blank one on resume.
 */
export function pauseRun(
  info: Omit<PausedRun, 'since' | 'deadline'>,
  opts: { keepAlive?: () => Promise<void>; keepAliveMs?: number } = {},
): Promise<PauseOutcome> {
  const since = new Date();
  return new Promise<PauseOutcome>((resolve) => {
    let done = false;
    const settle = (outcome: PauseOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(ping);
      paused.delete(info.runId);
      resolve(outcome);
    };
    const timer = setTimeout(() => settle('timeout'), info.timeoutMs);
    const ping = setInterval(() => {
      opts.keepAlive?.().catch(() => undefined);
    }, opts.keepAliveMs ?? 60_000);
    paused.set(info.runId, {
      ...info,
      since: since.toISOString(),
      deadline: new Date(since.getTime() + info.timeoutMs).toISOString(),
      settle,
    });
  });
}

export function resumeRun(runId: number): boolean {
  const e = paused.get(runId);
  if (!e) return false;
  e.settle('resumed');
  return true;
}

export function abortPausedRun(runId: number): boolean {
  const e = paused.get(runId);
  if (!e) return false;
  e.settle('aborted');
  return true;
}
