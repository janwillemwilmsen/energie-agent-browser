import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  boundSessionNames,
  clearPersistedSessionState,
  hasPersistedState,
  listPersistedStates,
} from '../agentBrowser/driver.js';

// Admin surface over agent-browser's persisted --session-name state files.
//
// Each preflight that saves state writes ~/.agent-browser/sessions/<name>.json
// (see persistedStatePath in driver.ts). On every scenario run that uses a
// preflight, that file is loaded back into the browser — so a cookie-consent
// preflight whose accepted-cookie state got baked into this file will find the
// banner already gone and its "click accept" step fails. Deleting the file
// resets that session to a clean slate so the banner reappears on the next run.

// Session/preflight names are used as filenames, so keep them to a safe set and
// reject anything that could escape the sessions directory.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export interface SessionStateInfo {
  name: string;
  file: string;
  sizeBytes: number;
  modifiedAt: string;
  // True when a live daemon is currently bound to this --session-name (i.e. a
  // ".session-name" marker in ~/.agent-browser points at it). Deleting an
  // in-use state won't take effect until that daemon is restarted.
  inUse: boolean;
}

export async function sessionStatesRoutes(app: FastifyInstance) {
  app.get('/api/session-states', async () => {
    const bound = boundSessionNames();
    const out: SessionStateInfo[] = listPersistedStates().map((st) => ({ ...st, inUse: bound.has(st.name) }));
    return out;
  });

  app.delete<{ Params: { name: string } }>('/api/session-states/:name', async (req, reply) => {
    const name = req.params.name;
    if (!SAFE_NAME.test(name) || path.basename(name) !== name) {
      return reply.code(400).send({ error: 'invalid_name' });
    }
    if (!hasPersistedState(name)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    // Reuse the driver's helper so we clear both the "<name>.json" file and the
    // (older/alternate) "<name>" directory shape agent-browser may have written.
    clearPersistedSessionState(name);
    return reply.code(204).send();
  });
}
