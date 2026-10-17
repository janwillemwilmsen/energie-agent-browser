import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  allDevices,
  deviceSource,
  deviceSourceIsCustom,
  enabledDeviceNames,
  saveDeviceSizes,
  saveDeviceSource,
  saveEnabledDeviceNames,
} from '../devices.js';

// The admin Devices page and the screenshot step's device dropdown.

const Size = z.object({ width: z.number().int().min(1).max(20_000), height: z.number().int().min(1).max(20_000) });

const Update = z.object({
  /** Replace the device source (a Playwright deviceDescriptorsSource.json); '' restores the vendored copy. */
  source: z.string().max(2_000_000).optional(),
  /** Screen and viewport sizes edited inline, by device name; written into the source. */
  sizes: z.record(z.string().min(1).max(80), z.object({ screen: Size, viewport: Size })).optional(),
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
    try {
      if (body.source !== undefined) saveDeviceSource(body.source);
      if (body.sizes !== undefined) saveDeviceSizes(body.sizes);
    } catch (e: any) {
      return reply.code(400).send({ error: 'invalid_source', message: e?.message ?? String(e) });
    }
    if (body.enabled !== undefined) saveEnabledDeviceNames(body.enabled);
    return { devices: allDevices(), enabled: enabledDeviceNames(), customSource: deviceSourceIsCustom() };
  });
}
