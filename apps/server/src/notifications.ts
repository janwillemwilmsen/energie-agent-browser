// The "a Run finished" seam. The runner raises one event; every registered
// adapter (web push, email, a test capture) receives it. Adapters are
// registered at start-up by the app's composition code, so the runner knows
// no channel and a test can listen without any channel configured.

export interface RunFinished {
  scenario: { id: number; name: string };
  runId: number;
  status: 'success' | 'failed';
}

export type RunListener = (event: RunFinished) => Promise<void> | void;

const listeners = new Set<RunListener>();

/** Register an adapter. Returns the unregister function. */
export function onRunFinished(listener: RunListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Deliver the event to every adapter and wait for all of them. A failing
 * adapter is logged and never stops the others or the caller.
 */
export async function notifyRunFinished(
  event: RunFinished,
  log: (message: string) => void = (m) => console.error(m),
): Promise<void> {
  const results = await Promise.allSettled([...listeners].map((l) => l(event)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const name = [...listeners][i]?.name || `listener #${i + 1}`;
      log(`notification adapter ${name} failed for run #${event.runId}: ${r.reason?.message ?? r.reason}`);
    }
  });
}
