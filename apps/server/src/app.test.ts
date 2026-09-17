import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { loadConfig, resetConfig, setConfig } from './config.js';
import { setDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { resetRunStore } from './runs/index.js';
import { createApp } from './app.js';

// The whole HTTP app over an injected configuration and an in-memory
// database: the composition root's second adapter set. No browser, no
// timers, no listen.

let app: FastifyInstance;
let dataDir: string;

function install(env: NodeJS.ProcessEnv): void {
  const loaded = loadConfig({ BROWSER_MODE: 'local', DATA_DIR: dataDir, ...env });
  if (!loaded.ok) throw new Error(`config: ${loaded.missing.join(', ')}`);
  setConfig(loaded.config);
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eab-app-'));
  install({ APP_AUTH_ENABLED: 'false' });
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  setDb(db);
  migrate(db);
  resetRunStore();
  app = await createApp({ logger: false, webDist: null });
});

afterAll(async () => {
  await app.close();
  resetConfig();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('the app over an in-memory database', () => {
  it('answers the health check', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('creates a scenario, lists it, and sees no runs', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: { name: 'Shop', url: 'https://shop.test/', viewport_preset: 'desktop' },
    });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/api/scenarios' });
    expect(list.json().map((s: { name: string }) => s.name)).toEqual(['Shop']);
    const runs = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toEqual([]);
  });

  it('rejects a malformed Scenario Step with a 400 naming the field', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/scenarios',
      payload: { name: 'S2', url: 'https://s2.test/', viewport_preset: 'desktop' },
    });
    const id = created.json().id;
    const bad = await app.inject({
      method: 'POST',
      url: `/api/scenarios/${id}/steps`,
      payload: { position: 0, kind: 'navigate', payload: { url: 'not a url' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'validation_error', message: expect.stringMatching(/invalid navigate step at url/) });
  });

  it('gates the API behind the login when auth is enabled', async () => {
    install({ APP_AUTH_ENABLED: 'true' });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/runs' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthenticated' });
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
    } finally {
      install({ APP_AUTH_ENABLED: 'false' });
    }
  });
});
