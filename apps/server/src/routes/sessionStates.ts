import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { clearPersistedSessionState } from '../agentBrowser/driver.js';

// Admin surface over agent-browser's persisted --session-name state files.
//
// Each preflight that saves state writes ~/.agent-browser/sessions/<name>.json
// (see persistedStatePath in driver.ts). On every scenario run that uses a
// preflight, that file is loaded back into the browser — so a cookie-consent
// preflight whose accepted-cookie state got baked into this file will find the
// banner already gone and its "click accept" step fails. Deleting the file
// resets that session to a clean slate so the banner reappears on the next run.

const SESSIONS_DIR = path.join(os.homedir(), '.agent-browser', 'sessions');
const AGENT_BROWSER_DIR = path.join(os.homedir(), '.agent-browser');

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

// Names currently bound to a live daemon: read every "<session>.session-name"
// marker and collect its contents.
function boundSessionNames(): Set<string> {
  const names = new Set<string>();
  try {
    for (const f of fs.readdirSync(AGENT_BROWSER_DIR)) {
      if (!f.endsWith('.session-name')) continue;
      try {
        const v = fs.readFileSync(path.join(AGENT_BROWSER_DIR, f), 'utf-8').trim();
        if (v) names.add(v);
      } catch {
        /* ignore unreadable marker */
      }
    }
  } catch {
    /* dir missing — no daemons have ever run */
  }
  return names;
}

export async function sessionStatesRoutes(app: FastifyInstance) {
  app.get('/api/session-states', async () => {
    const bound = boundSessionNames();
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(SESSIONS_DIR);
    } catch {
      return [] as SessionStateInfo[]; // dir doesn't exist yet → nothing saved
    }
    const out: SessionStateInfo[] = [];
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const name = file.slice(0, -'.json'.length);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(SESSIONS_DIR, file));
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      out.push({
        name,
        file,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        inUse: bound.has(name),
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  });

  app.delete<{ Params: { name: string } }>('/api/session-states/:name', async (req, reply) => {
    const name = req.params.name;
    if (!SAFE_NAME.test(name) || path.basename(name) !== name) {
      return reply.code(400).send({ error: 'invalid_name' });
    }
    const jsonPath = path.join(SESSIONS_DIR, `${name}.json`);
    const dirPath = path.join(SESSIONS_DIR, name);
    if (!fs.existsSync(jsonPath) && !fs.existsSync(dirPath)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    // Reuse the driver's helper so we clear both the "<name>.json" file and the
    // (older/alternate) "<name>" directory shape agent-browser may have written.
    clearPersistedSessionState(name);
    return reply.code(204).send();
  });
}
