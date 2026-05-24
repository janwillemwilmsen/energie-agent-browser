import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { run, runJson } from '../agentBrowser/driver.js';
import { parseSnapshotText } from '../agentBrowser/parser.js';

const SnapshotBody = z.object({
  url: z.string().url().optional(),
  session: z.string().default('default'),
  compact: z.boolean().default(true),
  interactiveOnly: z.boolean().default(false),
});

interface RawSnapshot {
  origin: string;
  refs: Record<string, { role: string; name: string }>;
  snapshot: string;
}

export async function snapshotRoutes(app: FastifyInstance) {
  app.post('/api/snapshot', async (req, reply) => {
    const body = SnapshotBody.parse(req.body ?? {});

    if (body.url) {
      const openRes = await run(['open', body.url], { session: body.session, timeoutMs: 60_000 });
      if (openRes.exitCode !== 0) {
        return reply.code(502).send({
          error: 'open_failed',
          stderr: openRes.stderr,
          stdout: openRes.stdout,
        });
      }
    }

    const snapArgs: string[] = ['snapshot'];
    if (body.compact) snapArgs.push('--compact');
    if (body.interactiveOnly) snapArgs.push('--interactive');

    try {
      const data = await runJson<RawSnapshot>(snapArgs, { session: body.session });
      const tree = parseSnapshotText(data.snapshot ?? '', data.origin ?? body.url ?? '');
      return { tree, raw: data };
    } catch (e: any) {
      return reply.code(502).send({ error: 'snapshot_failed', message: e.message });
    }
  });
}
