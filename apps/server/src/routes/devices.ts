import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  allDevices,
  deviceSource,
  deviceSourceIsCustom,
  enabledDeviceNames,
  saveDeviceSource,
  saveEnabledDeviceNames,
} from '../devices.js';

// The admin Devices page and the screenshot step's device dropdown.

const Update = z.object({
  /** Replace the device source (a Playwright deviceDescriptorsSource.json); '' restores the vendored copy. */
  source: z.string().max(2_000_000).optional(),
  /** Which device names the screenshot dropdown offers. */
  enabled: z.array(z.string().min(1).max(80)).max(1000).optional(),
});

export async function devicesRoutes(app: FastifyInstance) {
  app.get('/api/devices', async () => ({
    devices: allDevices(),
    enabled: enabledDeviceNames(),
    customSource: deviceSourceIsCustom(),
  }));

  /** The raw source text, for the editable view (large; fetched on demand). */
  app.get('/api/devices/source', async () => ({ source: deviceSource() }));

  app.put('/api/devices', async (req, reply) => {
    const body = Update.parse(req.body ?? {});
    if (body.source !== undefined) {
      try {
        saveDeviceSource(body.source);
      } catch (e: any) {
        return reply.code(400).send({ error: 'invalid_source', message: e?.message ?? String(e) });
      }
    }
    if (body.enabled !== undefined) saveEnabledDeviceNames(body.enabled);
    return { devices: allDevices(), enabled: enabledDeviceNames(), customSource: deviceSourceIsCustom() };
  });
}
