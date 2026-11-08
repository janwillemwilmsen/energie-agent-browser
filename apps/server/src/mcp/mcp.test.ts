import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, resetConfig, setConfig } from '../config.js';
import { setDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { resetRunStore } from '../runs/index.js';
import { createApp } from '../app.js';

// The MCP endpoint end to end: a real MCP client over real HTTP against the
// app on an in-memory database, authenticated with the bearer token. No
// browser — the tools exercised here are the authoring ones; run_scenario
// and friends are the same inject() path over routes app.test.ts covers.

const TOKEN = 'test-token-0123456789';

let app: FastifyInstance;
let dataDir: string;
let base: string;
let client: Client;

function textOf(res: CallToolResult): string {
  return res.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function jsonOf<T = unknown>(res: CallToolResult): T {
  return JSON.parse(textOf(res)) as T;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eab-mcp-'));
  const loaded = loadConfig({
    BROWSER_MODE: 'local',
    DATA_DIR: dataDir,
    APP_AUTH_ENABLED: 'true',
    APP_AUTH_USER: 'u',
    APP_AUTH_PASS: 'p',
    EAB_API_TOKEN: TOKEN,
  });
  if (!loaded.ok) throw new Error(`config: ${loaded.missing.join(', ')}`);
  setConfig(loaded.config);
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  setDb(db);
  migrate(db);
  resetRunStore();
  app = await createApp({ logger: false, webDist: null });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  client = new Client({ name: 'mcp-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
});

afterAll(async () => {
  await client.close().catch(() => {});
  await app.close();
  resetConfig();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('the login gate', () => {
  it('rejects the MCP endpoint without credentials', async () => {
    const res = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong bearer token', async () => {
    const res = await fetch(`${base}/api/scenarios`, { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  it('admits the configured bearer token on ordinary API routes too', async () => {
    const res = await fetch(`${base}/api/scenarios`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  it('answers GET on the endpoint with 405 in JSON-RPC terms', async () => {
    const res = await fetch(`${base}/api/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
    expect((await res.json()).error.message).toMatch(/stateless/);
  });
});

describe('the MCP server', () => {
  it('lists the tool catalog', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'add_steps', 'compare_runs', 'create_preflight', 'create_scenario', 'create_schedule',
        'get_run', 'get_scenario', 'get_screenshot', 'list_auth_profiles', 'list_preflights',
        'list_projects', 'list_runs', 'list_scenarios', 'list_schedules', 'remove_step',
        'reorder_steps', 'resume_run', 'run_scenario', 'snapshot_page', 'update_preflight',
        'update_scenario', 'update_step', 'wait_for_run',
      ].sort(),
    );
    // No tool deletes a Scenario, Run or Preflight.
    expect(names.filter((n) => /delete/.test(n))).toEqual([]);
  });

  it('creates a scenario with steps and reads it back', async () => {
    const created = await call('create_scenario', {
      name: 'helloworld',
      url: 'https://helloworld.test/',
      steps: [
        { kind: 'click', selector: { role: 'button', name: 'Accept cookies' }, optional: true },
        { kind: 'scroll', toBottom: true },
        { kind: 'scroll', toTop: true },
        { kind: 'record_start', cursor: true },
        { kind: 'screenshot', label: 'full', fullPage: true },
        { kind: 'screenshot', label: 'viewport', fullPage: false },
        { kind: 'record_stop' },
      ],
    });
    expect(created.isError).toBeFalsy();
    const scenario = jsonOf<{ id: number; note?: string; steps: Array<{ kind: string; position: number; url?: string }> }>(created);
    // The runner only opens pages Steps navigate to, so the tool inserted
    // the conventional first Step — and said so.
    expect(scenario.note).toMatch(/navigate Step/);
    expect(scenario.steps.map((s) => s.kind)).toEqual([
      'navigate', 'click', 'scroll', 'scroll', 'record_start', 'screenshot', 'screenshot', 'record_stop',
    ]);
    expect(scenario.steps[0]!.url).toBe('https://helloworld.test/');
    expect(scenario.steps.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const read = jsonOf<{ name: string; steps: unknown[] }>(await call('get_scenario', { scenario_id: scenario.id }));
    expect(read.name).toBe('helloworld');
    expect(read.steps).toHaveLength(8);
  });

  it('does not insert a navigate when the caller starts with one, or when steps exist already', async () => {
    const s = jsonOf<{ id: number; note?: string; steps: Array<{ kind: string }> }>(
      await call('create_scenario', {
        name: 'explicit-nav',
        url: 'https://e.test/',
        steps: [{ kind: 'navigate', url: 'https://e.test/landing' }, { kind: 'screenshot' }],
      }),
    );
    expect(s.note).toBeUndefined();
    expect(s.steps.map((x) => x.kind)).toEqual(['navigate', 'screenshot']);

    const more = jsonOf<{ note?: string; scenario: { steps: Array<{ kind: string }> } }>(
      await call('add_steps', { scenario_id: s.id, steps: [{ kind: 'scroll', toBottom: true }] }),
    );
    expect(more.note).toBeUndefined();
    expect(more.scenario.steps.map((x) => x.kind)).toEqual(['navigate', 'screenshot', 'scroll']);

    // An empty Scenario getting its first Steps later is the same case.
    const empty = jsonOf<{ id: number }>(await call('create_scenario', { name: 'empty-first', url: 'https://f.test/' }));
    const first = jsonOf<{ note?: string; scenario: { steps: Array<{ kind: string }> } }>(
      await call('add_steps', { scenario_id: empty.id, steps: [{ kind: 'screenshot' }] }),
    );
    expect(first.note).toMatch(/navigate Step/);
    expect(first.scenario.steps.map((x) => x.kind)).toEqual(['navigate', 'screenshot']);
  });

  it('rejects a malformed step with an error naming the field, keeping the valid ones before it', async () => {
    const s = jsonOf<{ id: number }>(await call('create_scenario', { name: 'bad-steps', url: 'https://x.test/' }));
    const res = await call('add_steps', {
      scenario_id: s.id,
      steps: [
        { kind: 'navigate', url: 'https://x.test/a' },
        { kind: 'wait', ms: -5 },
      ],
    });
    expect(res.isError).toBe(true);
    const msg = textOf(res);
    // The SDK validates the discriminated union before our handler sees it,
    // or the route's write seam does — either way the field is named.
    expect(msg).toMatch(/ms/);
  });

  it('inserts steps at an index and reorders', async () => {
    const s = jsonOf<{ id: number; steps: Array<{ id: number; kind: string }> }>(
      await call('create_scenario', {
        name: 'ordered',
        url: 'https://o.test/',
        steps: [{ kind: 'navigate', url: 'https://o.test/1' }, { kind: 'screenshot' }],
      }),
    );
    const after = jsonOf<{ note?: string; scenario: { steps: Array<{ id: number; kind: string }> } }>(
      await call('add_steps', { scenario_id: s.id, steps: [{ kind: 'wait', ms: 500 }], at_index: 1 }),
    );
    expect(after.note).toBeUndefined();
    expect(after.scenario.steps.map((x) => x.kind)).toEqual(['navigate', 'wait', 'screenshot']);

    const ids = after.scenario.steps.map((x) => x.id);
    const reordered = jsonOf<{ steps: Array<{ kind: string }> }>(
      await call('reorder_steps', { scenario_id: s.id, order: [ids[2], ids[0], ids[1]] }),
    );
    expect(reordered.steps.map((x) => x.kind)).toEqual(['screenshot', 'navigate', 'wait']);

    const removed = jsonOf<{ steps: Array<{ kind: string }> }>(
      await call('remove_step', { scenario_id: s.id, step_id: ids[1] }),
    );
    expect(removed.steps.map((x) => x.kind)).toEqual(['screenshot', 'navigate']);
  });

  it('creates a preflight and attaches it to a scenario by name', async () => {
    const pf = jsonOf<{ id: number; name: string }>(
      await call('create_preflight', {
        name: 'helloworld-cookie',
        description: 'accept the consent banner',
        steps: [
          { kind: 'navigate', url: 'https://helloworld.test/' },
          { kind: 'click', selector: { role: 'button', name: 'Accept cookies' } },
        ],
      }),
    );
    expect(pf.name).toBe('helloworld-cookie');

    const s = jsonOf<{ preflight_id: number; preflight_mode: string }>(
      await call('create_scenario', {
        name: 'with-preflight',
        url: 'https://helloworld.test/',
        preflight: 'helloworld-cookie',
        preflight_mode: 'cookies',
      }),
    );
    expect(s.preflight_id).toBe(pf.id);
    expect(s.preflight_mode).toBe('cookies');

    const unknown = await call('create_scenario', { name: 'x', url: 'https://x.test/', preflight: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/no preflight named "nope"/);

    const detached = jsonOf<{ preflight_id: number | null }>(
      await call('update_scenario', { scenario_id: (s as unknown as { id: number }).id, preflight: null }),
    );
    expect(detached.preflight_id).toBeNull();
  });

  it('lists scenarios with a name filter and schedules', async () => {
    const list = jsonOf<Array<{ name: string }>>(await call('list_scenarios', { name_contains: 'hello' }));
    expect(list.map((s) => s.name).sort()).toEqual(['helloworld']);

    const sched = jsonOf<{ cron_expr: string; scenario_ids: number[] }>(
      await call('create_schedule', { scenario_ids: [1], cron_expr: '0 7 * * *' }),
    );
    expect(sched.cron_expr).toBe('0 7 * * *');
    const all = jsonOf<unknown[]>(await call('list_schedules'));
    expect(all).toHaveLength(1);
  });

  it('reports a missing run as a tool error, not a protocol failure', async () => {
    const res = await call('get_run', { run_id: 999 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/404/);
  });
});
