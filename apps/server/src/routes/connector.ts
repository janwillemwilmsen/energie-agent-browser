import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { diagnoseRelay, listPcs, pairingCode, regeneratePairingCode } from '../connector/hub.js';

// Admin → Browser → Your own PC: the pairing code, who is connected, and the
// connector script itself (served from apps/server/connector/ so the PC gets
// the version that matches this server).
//
// GET  /api/admin/connector         { code, pcs }
// POST /api/admin/connector/code    a fresh code → { code }; running connectors keep
//                                   their connection, new ones need the new code
// GET  /api/admin/connector/script  eab-connect.mjs as a download
// POST /api/admin/connector/diagnose
//                                   walk the relay the way the daemon does and
//                                   report which hop breaks → { ok, steps }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '..', '..', 'connector', 'eab-connect.mjs');

export async function connectorRoutes(app: FastifyInstance) {
  app.get('/api/admin/connector', async () => ({ code: pairingCode(), pcs: listPcs() }));

  app.post('/api/admin/connector/code', async () => ({ code: regeneratePairingCode() }));

  const DiagnoseBody = z.object({ pc: z.string().trim().max(60).default('') });
  app.post('/api/admin/connector/diagnose', async (req) => diagnoseRelay(DiagnoseBody.parse(req.body ?? {}).pc));

  app.get('/api/admin/connector/script', async (_req, reply) => {
    const body = await fs.promises.readFile(SCRIPT_PATH, 'utf-8');
    return reply
      .header('content-type', 'text/javascript; charset=utf-8')
      .header('content-disposition', 'attachment; filename="eab-connect.mjs"')
      .send(body);
  });
}
