import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSetting, setSetting } from '../settings.js';

// The UI's colour scheme (admin Theme page): one id, stored in app_settings
// and shared by every browser. The web owns the list of schemes and falls
// back to its default for an id it does not know.

const KEY = 'ui.theme';

const Body = z.object({
  /** A scheme id; '' or null clears the setting (the default scheme). */
  theme: z.string().max(40).nullable(),
});

export async function themeRoutes(app: FastifyInstance) {
  app.get('/api/admin/theme', async () => ({ theme: getSetting(KEY) }));

  app.put('/api/admin/theme', async (req) => {
    const { theme } = Body.parse(req.body ?? {});
    setSetting(KEY, theme && /^[a-z0-9-]+$/.test(theme) ? theme : null);
    return { theme: getSetting(KEY) };
  });
}
