import { run, runJson, closeSession } from './driver.js';
import { parseSnapshotText } from './parser.js';
import type { Browser } from '../scenarios/stepExecutor.js';

/**
 * The production adapter at the Browser seam: routes every call to the
 * agent-browser daemon for one named session. The Step executor never sees
 * the session name, the daemon lifecycle, or the CLI's JSON envelope.
 */
export function cliBrowser(session: string): Browser {
  return {
    run: (args, opts) => run(args, { session, timeoutMs: opts?.timeoutMs }),
    snapshot: async () => {
      const data = await runJson<{ origin: string; snapshot: string }>(
        ['snapshot', '--compact'],
        { session, timeoutMs: 30_000 },
      );
      return parseSnapshotText(data.snapshot ?? '', data.origin ?? '');
    },
    close: () => closeSession(session),
  };
}
