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

  // Projects: the X-Project-Id header scopes lists and is the default owner
  // of what a request creates; without it everything shows.
  it('scopes scenarios, runs and schedules to the X-Project-Id project', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Essent', color: '#ff0066' } });
    expect(created.statusCode).toBe(201);
    const essent = created.json().id as number;
    expect(essent).toBeGreaterThan(1);

    // Created under the header → lands in that project.
    const s = await app.inject({
      method: 'POST', url: '/api/scenarios', headers: { 'x-project-id': String(essent) },
      payload: { name: 'Essent home', url: 'https://essent.test/', viewport_preset: 'desktop' },
    });
    expect(s.statusCode).toBe(201);
    expect(s.json().project_id).toBe(essent);

    const names = async (headers?: Record<string, string>) =>
      (await app.inject({ method: 'GET', url: '/api/scenarios', headers })).json().map((x: { name: string }) => x.name).sort();
    expect(await names({ 'x-project-id': String(essent) })).toEqual(['Essent home']);
    expect(await names({ 'x-project-id': '1' })).toEqual(['S2', 'Shop']);
    expect(await names()).toEqual(['Essent home', 'S2', 'Shop']);
    expect(await names({ 'x-project-id': 'all' })).toEqual(['Essent home', 'S2', 'Shop']);

    // Lists rooted in scenarios follow: runs (none yet, but the filter parses), cards.
    const cards = await app.inject({ method: 'GET', url: '/api/scenarios/cards', headers: { 'x-project-id': String(essent) } });
    expect(cards.json()).toHaveLength(1);
    const runs = await app.inject({ method: 'GET', url: '/api/runs', headers: { 'x-project-id': String(essent) } });
    expect(runs.json()).toEqual([]);
    const count = await app.inject({ method: 'GET', url: '/api/runs/count', headers: { 'x-project-id': String(essent) } });
    expect(count.json()).toEqual({ total: 0 });

    // A schedule may not chain scenarios of two projects; one project's chain takes that project.
    const shop = (await app.inject({ method: 'GET', url: '/api/scenarios', headers: { 'x-project-id': '1' } })).json()[0].id;
    const mixed = await app.inject({ method: 'POST', url: '/api/schedules', payload: { scenario_ids: [shop, s.json().id], cron_expr: '0 3 * * *' } });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json()).toMatchObject({ error: 'mixed_projects' });
    const ok = await app.inject({ method: 'POST', url: '/api/schedules', payload: { scenario_ids: [s.json().id], cron_expr: '0 3 * * *' } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().project_id).toBe(essent);
    const schedules = async (project: string) =>
      (await app.inject({ method: 'GET', url: '/api/schedules', headers: { 'x-project-id': project } })).json();
    expect(await schedules(String(essent))).toHaveLength(1);
    expect(await schedules('1')).toHaveLength(0);

    // A non-empty project cannot go; the Default project never goes.
    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${essent}` });
    expect(del.statusCode).toBe(409);
    expect(del.json()).toMatchObject({ error: 'not_empty', scenarios: 1, schedules: 1 });
    expect((await app.inject({ method: 'DELETE', url: '/api/projects/1' })).statusCode).toBe(409);

    // Bulk move by brand: the scenario and its single-member schedule move together.
    await app.inject({ method: 'PUT', url: `/api/scenarios/${s.json().id}`, payload: { brand: 'Essent' } });
    const moved = await app.inject({ method: 'POST', url: '/api/projects/1/move-scenarios', payload: { brand: 'essent' } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ moved: 1 });
    expect(await names({ 'x-project-id': String(essent) })).toEqual([]);
    expect(await schedules('1')).toHaveLength(1);
    // Now empty, it can go; its listing shows what each project holds.
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${essent}` })).statusCode).toBe(204);
    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json()).toMatchObject([{ id: 1, name: 'Default', scenario_count: 3, schedule_count: 1 }]);
    // An unknown project on create is a 400, not a silent fallback.
    const bad = await app.inject({ method: 'POST', url: '/api/scenarios', headers: { 'x-project-id': '999' }, payload: { name: 'X', url: 'https://x.test/', viewport_preset: 'desktop' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'unknown_project' });
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
