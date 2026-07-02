import type { FastifyInstance } from 'fastify';
import { AuthProfileCreate } from '@eab/shared';
import { run, runWithStdin, PREFLIGHT_RECORDER_SESSION } from '../agentBrowser/driver.js';
import { getAuthSelectors, setAuthSelectors, deleteAuthSelectors } from '../authSelectors.js';

const RUN_OPTS = { session: PREFLIGHT_RECORDER_SESSION, timeoutMs: 8_000 };

// agent-browser's CLI always tries to bootstrap a browserless connection on
// startup, even for purely-local commands like `auth list`. When no daemon is
// alive, that bootstrap fails (os error 10060) — so we route every auth CRUD
// call through the live `default` daemon. ensureSession (inside `run`) brings
// the daemon up if it isn't, and reuses it if it is.

// agent-browser owns the storage and encryption — auth profiles live under
// ~/.agent-browser/auth/<name>.json, AES-GCM encrypted with the key in
// ~/.agent-browser/.encryption-key. We never touch the files directly; every
// CRUD endpoint shells out to the corresponding `agent-browser auth …`
// subcommand. The native binary is the source of truth.

// Output line format from `agent-browser auth list`:
//   Auth profiles:
//     <name> <username> <url>
// We parse it permissively (treat as whitespace-separated, allow the URL to
// contain spaces theoretically by taking the last token first).
function parseListOutput(stdout: string): Array<{ name: string; username: string; url: string }> {
  const out: Array<{ name: string; username: string; url: string }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/^\s+|\s+$/g, '').replace(/^✓\s*/, '');
    if (!line) continue;
    // Header line ("Auth profiles:") and the empty-vault sentinel
    // ("No auth profiles saved.") are not rows — skip them so the response
    // is a clean empty array when there's nothing saved.
    if (/^auth profiles[:\s]?$/i.test(line)) continue;
    if (/^no auth profiles saved/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const name = parts[0]!;
    const url = parts[parts.length - 1]!;
    const username = parts.slice(1, -1).join(' ');
    out.push({ name, username, url });
  }
  return out;
}

// `auth show <name>` output:
//   Name: <name>
//   URL: <url>
//   Username: <user>
//   Created:
function parseShowOutput(stdout: string): { name: string; url: string; username: string } | null {
  const m = (re: RegExp) => stdout.match(re)?.[1]?.trim() ?? '';
  const name = m(/^Name:\s*(.+)$/m);
  const url = m(/^URL:\s*(.+)$/m);
  const username = m(/^Username:\s*(.+)$/m);
  if (!name && !url && !username) return null;
  return { name, url, username };
}

export async function authProfilesRoutes(app: FastifyInstance) {
  app.get('/api/auth-profiles', async () => {
    const r = await run(['auth', 'list'], RUN_OPTS);
    if (r.exitCode !== 0) {
      throw new Error(`auth list failed: ${r.stderr || r.stdout}`);
    }
    // Merge in the selector overrides we persist ourselves (agent-browser's
    // vault doesn't store them), so the UI can display which selectors a
    // profile uses.
    return parseListOutput(r.stdout).map((p) => ({ ...p, ...getAuthSelectors(p.name) }));
  });

  app.get<{ Params: { name: string } }>('/api/auth-profiles/:name', async (req, reply) => {
    const r = await run(['auth', 'show', req.params.name], RUN_OPTS);
    if (r.exitCode !== 0) {
      return reply.code(404).send({ error: 'not_found', detail: r.stderr || r.stdout });
    }
    const parsed = parseShowOutput(r.stdout);
    if (!parsed) return reply.code(404).send({ error: 'not_found' });
    return { ...parsed, ...getAuthSelectors(req.params.name) };
  });

  app.post('/api/auth-profiles', async (req, reply) => {
    const body = AuthProfileCreate.parse(req.body);
    // Pass the password via --password-stdin so it never sits in a process
    // argv (which would be visible in `ps`/Task Manager and any audit logs).
    // agent-browser reads exactly one line from stdin.
    // NOTE: `auth save` accepts only name/url/username/password — the selector
    // flags are valid only on `auth login`. So we do NOT pass them here; we
    // persist them ourselves (below) and re-apply them when an auth-login step
    // runs (see preflightExecutor).
    const args = [
      'auth', 'save', body.name,
      '--url', body.url,
      '--username', body.username,
      '--password-stdin',
    ];

    const r = await runWithStdin(args, body.password, RUN_OPTS);
    if (r.exitCode !== 0) {
      return reply.code(400).send({ error: 'save_failed', detail: r.stderr || r.stdout });
    }
    setAuthSelectors(body.name, {
      usernameSelector: body.usernameSelector,
      passwordSelector: body.passwordSelector,
      submitSelector: body.submitSelector,
    });
    return reply.code(201).send({
      name: body.name,
      url: body.url,
      username: body.username,
      ...getAuthSelectors(body.name),
    });
  });

  app.delete<{ Params: { name: string } }>('/api/auth-profiles/:name', async (req, reply) => {
    const r = await run(['auth', 'delete', req.params.name], RUN_OPTS);
    if (r.exitCode !== 0) {
      return reply.code(404).send({ error: 'delete_failed', detail: r.stderr || r.stdout });
    }
    deleteAuthSelectors(req.params.name);
    return reply.code(204).send();
  });
}
