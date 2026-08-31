import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import dotenv from 'dotenv';
import { z } from 'zod';

// Admin: view + edit the repo-root .env file from the UI.
//
// GET  /api/admin/env  → the parsed entries (key/value + a "secret" hint so the
//                        UI can mask tokens/passwords by default).
// PUT  /api/admin/env  → full replacement set of active entries. The file is
//                        rewritten line-by-line so comments, blank lines and
//                        key order are preserved; removed keys drop their line,
//                        new keys are appended at the end. A .env.bak copy of
//                        the previous content is written first.
//
// The endpoint sits behind the same global session gate as every other /api/*
// route. Note that `config` (config.ts) snapshots env at boot, so most changes
// only take effect after a server restart — we do refresh process.env for the
// few spots that read it lazily, and the response says restartRequired.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const envPath = path.join(repoRoot, '.env');

// Heuristic for values the UI should mask until explicitly revealed.
const SECRET_RE = /(TOKEN|SECRET|KEY|PASS|PASSWORD|CREDENTIAL)/i;

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PutBody = z.object({
  entries: z
    .array(
      z.object({
        key: z.string().regex(KEY_RE, 'invalid env var name'),
        value: z.string().max(10_000),
      }),
    )
    .max(500)
    // Duplicate keys in the payload would make the rewrite ambiguous.
    .refine(
      (arr) => new Set(arr.map((e) => e.key)).size === arr.length,
      'duplicate keys in entries',
    ),
});

// Matches an active (non-comment) assignment line and captures the key.
const LINE_KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

// Render a value the way dotenv can read it back: bare when it's simple,
// double-quoted (with escapes) when it contains spaces, #, quotes, etc.
function formatValue(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./:@+,=\-]+$/.test(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');
  return `"${escaped}"`;
}

export async function adminEnvRoutes(app: FastifyInstance) {
  app.get('/api/admin/env', async () => {
    const exists = fs.existsSync(envPath);
    const content = exists ? fs.readFileSync(envPath, 'utf8') : '';
    const parsed = dotenv.parse(content);
    // Preserve file order: walk the lines, emit keys in the order they appear.
    const orderedKeys: string[] = [];
    for (const line of content.split(/\r?\n/)) {
      const key = LINE_KEY_RE.exec(line)?.[1];
      if (key && key in parsed && !orderedKeys.includes(key)) orderedKeys.push(key);
    }
    // Anything dotenv parsed but we didn't spot line-by-line (multi-line
    // values) still gets listed, at the end.
    for (const k of Object.keys(parsed)) {
      if (!orderedKeys.includes(k)) orderedKeys.push(k);
    }
    return {
      path: envPath,
      exists,
      updatedAt: exists ? fs.statSync(envPath).mtime.toISOString() : null,
      entries: orderedKeys.map((key) => ({
        key,
        value: parsed[key] ?? '',
        secret: SECRET_RE.test(key),
      })),
    };
  });

  app.put('/api/admin/env', async (req) => {
    const { entries } = PutBody.parse(req.body);
    const next = new Map(entries.map((e) => [e.key, e.value]));

    const oldContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const before = dotenv.parse(oldContent);

    // Rewrite line-by-line: keep comments/blank lines as-is, replace the value
    // on lines whose key is still present, drop lines whose key was removed.
    // Lines whose value is unchanged are kept byte-for-byte, so their original
    // quoting and inline "# comments" survive.
    const eol = oldContent.includes('\r\n') ? '\r\n' : '\n';
    const lines = oldContent.split(/\r?\n/);
    const seen = new Set<string>();
    const outLines: string[] = [];
    for (const line of lines) {
      const key = LINE_KEY_RE.exec(line)?.[1];
      if (!key) {
        outLines.push(line);
        continue;
      }
      if (seen.has(key)) continue; // duplicate assignment line — keep first only
      if (!next.has(key)) {
        seen.add(key); // removed key → drop the line
        continue;
      }
      seen.add(key);
      const value = next.get(key)!;
      outLines.push(value === before[key] ? line : `${key}=${formatValue(value)}`);
    }
    // New keys go at the end.
    const added = entries.filter((e) => !seen.has(e.key));
    if (added.length) {
      // Ensure exactly one blank separator line before the appended block.
      while (outLines.length && outLines[outLines.length - 1]?.trim() === '') outLines.pop();
      if (outLines.length) outLines.push('');
      for (const e of added) outLines.push(`${e.key}=${formatValue(e.value)}`);
    }
    let newContent = outLines.join(eol);
    if (!newContent.endsWith(eol)) newContent += eol;

    // Backup, then write.
    const backupPath = `${envPath}.bak`;
    if (oldContent) fs.writeFileSync(backupPath, oldContent, 'utf8');
    fs.writeFileSync(envPath, newContent, 'utf8');

    // Refresh process.env so code that reads it lazily picks up the change.
    // (config.ts snapshots at boot — those values still need a restart.)
    for (const [key, value] of next) process.env[key] = value;
    for (const key of Object.keys(before)) {
      if (!next.has(key)) delete process.env[key];
    }

    req.log.info(
      { keys: [...next.keys()], removed: Object.keys(before).filter((k) => !next.has(k)) },
      'admin: .env updated',
    );

    return { ok: true, restartRequired: true, backupPath };
  });
}
