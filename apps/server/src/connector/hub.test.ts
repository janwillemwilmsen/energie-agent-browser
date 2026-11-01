import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { config, loadConfig, resetConfig, setConfig } from '../config.js';
import { setDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { resetRunStore } from '../runs/index.js';
import { _setSecretsKeyForTests } from '../secrets.js';
import { createApp } from '../app.js';
import { cdpUrlFor, listPcs, pairingCode, pickPc, regeneratePairingCode, requirePc } from './hub.js';
import { backendEnv } from '../agentBrowser/backend.js';

// The relay end to end over a real listening app: a fake PC pairs with the
// code, a fake daemon connects to the loopback CDP endpoint, frames cross in
// both directions, and the guards (code, key, loopback-only) hold.

let app: FastifyInstance;
let dataDir: string;
let port: number;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eab-hub-'));
  const loaded = loadConfig({ BROWSER_MODE: 'local', DATA_DIR: dataDir, APP_AUTH_ENABLED: 'true', PORT: '0' });
  if (!loaded.ok) throw new Error(loaded.missing.join(', '));
  setConfig(loaded.config);
  const db = new Database(':memory:');
  setDb(db);
  migrate(db);
  resetRunStore();
  _setSecretsKeyForTests(crypto.randomBytes(32));
  app = await createApp({ logger: false, webDist: null });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  // cdpUrlFor embeds the configured port; point it at the ephemeral one.
  setConfig({ ...loaded.config, port });
});

afterAll(async () => {
  await app.close();
  _setSecretsKeyForTests(null);
  resetConfig();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Frames are queued from the moment the socket opens: the hub may send
// before the test gets round to listening (a race, not a bug).
const inboxes = new WeakMap<WebSocket, { queue: string[]; waiters: Array<(s: string) => void> }>();
const open = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    const box = { queue: [] as string[], waiters: [] as Array<(s: string) => void> };
    inboxes.set(ws, box);
    ws.on('message', (raw) => {
      const s = raw.toString();
      const w = box.waiters.shift();
      if (w) w(s); else box.queue.push(s);
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
const nextRaw = (ws: WebSocket) =>
  new Promise<string>((resolve) => {
    const box = inboxes.get(ws)!;
    const s = box.queue.shift();
    if (s !== undefined) resolve(s); else box.waiters.push(resolve);
  });
const next = async (ws: WebSocket) => JSON.parse(await nextRaw(ws));
const closed = (ws: WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));
// The hub's own close handling runs after the client sees the close; wait for it.
async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function pair(name: string, code = pairingCode()): Promise<{ ws: WebSocket; id: string }> {
  const ws = await open(`ws://127.0.0.1:${port}/ws/connector`);
  send(ws, { t: 'hello', code, name, platform: 'test', chunks: true, version: { browser: 'Chrome/1', protocolVersion: '1.3', userAgent: 'UA' } });
  const welcome = await next(ws);
  expect(welcome).toMatchObject({ t: 'welcome', name });
  return { ws, id: welcome.id };
}

describe('pairing code', () => {
  it('is created on first use, survives reads, and changes on regenerate', () => {
    const first = pairingCode();
    expect(first).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(pairingCode()).toBe(first);
    expect(regeneratePairingCode()).not.toBe(first);
  });
});

describe('the relay', () => {
  it('needs no app login on the connector socket but rejects a wrong code', async () => {
    const ws = await open(`ws://127.0.0.1:${port}/ws/connector`);
    send(ws, { t: 'hello', code: 'NOPE-NOPE-NOPE', name: 'x' });
    const c = await closed(ws);
    expect(c).toEqual({ code: 4001, reason: 'wrong pairing code' });
    expect(listPcs()).toEqual([]);
  });

  it('accepts the code with dashes or lowercase and lists the PC', async () => {
    const loose = pairingCode().toLowerCase().replace(/-/g, ' ');
    const { ws, id } = await pair('laptop', loose);
    expect(listPcs()).toMatchObject([{ id, name: 'laptop', platform: 'test', channels: 0, chromeOk: true, version: { browser: 'Chrome/1' } }]);
    expect(pickPc('')?.id).toBe(id);
    expect(pickPc('LAPTOP')?.id).toBe(id);
    expect(pickPc('desktop')).toBeNull();
    expect(requirePc('').id).toBe(id);
    expect(() => requirePc('desktop')).toThrow(/No connected PC is named "desktop" \(connected: laptop\)/);
    // Every command carries the endpoint: `connect <url>` does not stick, and on
    // Linux it silently launches a local browser instead of connecting.
    expect(backendEnv({ kind: 'connector', pc: '' }).AGENT_BROWSER_CDP).toBe(cdpUrlFor(id));
    expect(backendEnv({ kind: 'connector', pc: 'laptop' }).AGENT_BROWSER_CDP).toBe(cdpUrlFor(id));
    expect(backendEnv({ kind: 'connector', pc: 'desktop' }).AGENT_BROWSER_CDP).toBeUndefined();
    // Chrome gone on the PC: still listed, but refused as a run target until it is back.
    send(ws, { t: 'version', version: null });
    await until(() => listPcs()[0]?.chromeOk === false);
    expect(() => requirePc('')).toThrow(/"laptop" is connected but nothing answers on its Chrome debugging port/);
    send(ws, { t: 'version', version: { browser: 'Chrome/2' } });
    await until(() => listPcs()[0]?.chromeOk === true);
    expect(listPcs()[0]?.version.browser).toBe('Chrome/2');
    ws.close();
    await closed(ws);
    await until(() => listPcs().length === 0);
    expect(() => requirePc('')).toThrow(/No PC is connected — start eab-connect/);
  });

  it('pipes a daemon connection to a channel on the PC, both ways, and tears it down', async () => {
    const { ws: pc, id } = await pair('laptop');
    const daemon = await open(cdpUrlFor(id));
    // The hub asks the PC to dial Chrome for a new channel.
    expect(await next(pc)).toEqual({ t: 'open', ch: 1 });
    // Frames the daemon sends before the PC is ready are held, then flushed in order.
    daemon.send('{"id":1,"method":"Target.getTargets"}');
    daemon.send('{"id":2,"method":"Browser.getVersion"}');
    send(pc, { t: 'opened', ch: 1 });
    expect(await next(pc)).toEqual({ t: 'msg', ch: 1, data: '{"id":1,"method":"Target.getTargets"}' });
    expect(await next(pc)).toEqual({ t: 'msg', ch: 1, data: '{"id":2,"method":"Browser.getVersion"}' });
    expect(listPcs()[0]?.channels).toBe(1);
    // And Chrome's answers come back on the daemon socket, verbatim.
    send(pc, { t: 'msg', ch: 1, data: '{"id":1,"result":{"targetInfos":[]}}' });
    expect(await nextRaw(daemon)).toBe('{"id":1,"result":{"targetInfos":[]}}');
    // Daemon goes away → the PC is told to close its Chrome socket.
    daemon.close();
    expect(await next(pc)).toEqual({ t: 'close', ch: 1 });
    expect(listPcs()[0]?.channels).toBe(0);
    // A second channel gets the next number; a Chrome failure on the PC side closes the daemon with the reason.
    const daemon2 = await open(cdpUrlFor(id));
    expect(await next(pc)).toEqual({ t: 'open', ch: 2 });
    send(pc, { t: 'openfail', ch: 2, error: 'nothing on 9222' });
    expect(await closed(daemon2)).toEqual({ code: 1011, reason: 'Chrome on laptop: nothing on 9222' });
    // PC disconnects → every attached daemon is dropped.
    const daemon3 = await open(cdpUrlFor(id));
    await next(pc);
    pc.close();
    expect((await closed(daemon3)).code).toBe(1001);
    await until(() => listPcs().length === 0);
  });

  it('splits a big CDP message into frames and reassembles it, both ways', async () => {
    // A full-page screenshot is megabytes of base64 in ONE CDP message; sent as
    // a single frame it starves this socket's pong and the keepalive kills it.
    const { ws: pc, id } = await pair('laptop');
    const daemon = await open(cdpUrlFor(id));
    expect(await next(pc)).toEqual({ t: 'open', ch: 1 });
    send(pc, { t: 'opened', ch: 1 });

    // PC → daemon: the screenshot direction. Arrives whole, in order.
    const big = 'x'.repeat(600_000) + 'END';
    send(pc, { t: 'msg', ch: 1, data: big.slice(0, 300_000), more: true });
    send(pc, { t: 'msg', ch: 1, data: big.slice(300_000, 600_000), more: true });
    send(pc, { t: 'msg', ch: 1, data: big.slice(600_000) });
    expect(await nextRaw(daemon)).toBe(big);
    // A small one still arrives as a single frame.
    send(pc, { t: 'msg', ch: 1, data: '{"id":9}' });
    expect(await nextRaw(daemon)).toBe('{"id":9}');

    // daemon → PC: the hub chunks it, because this PC said it understands chunks.
    const outbound = 'y'.repeat(700_000);
    daemon.send(outbound);
    let got = '';
    for (;;) {
      const m = await next(pc);
      expect(m).toMatchObject({ t: 'msg', ch: 1 });
      got += m.data;
      expect(m.data.length).toBeLessThanOrEqual(256 * 1024);
      if (!m.more) break;
    }
    expect(got).toBe(outbound);

    daemon.close();
    expect(await next(pc)).toEqual({ t: 'close', ch: 1 });
    pc.close();
    await until(() => listPcs().length === 0);
  });

  it('sends whole messages to a connector that predates chunking', async () => {
    const ws = await open(`ws://127.0.0.1:${port}/ws/connector`);
    send(ws, { t: 'hello', code: pairingCode(), name: 'old', version: { browser: 'Chrome/1' } }); // no chunks: true
    const welcome = await next(ws);
    const daemon = await open(cdpUrlFor(welcome.id));
    expect(await next(ws)).toEqual({ t: 'open', ch: 1 });
    send(ws, { t: 'opened', ch: 1 });
    const outbound = 'z'.repeat(700_000);
    daemon.send(outbound);
    const m = await next(ws);
    expect(m).toEqual({ t: 'msg', ch: 1, data: outbound });
    daemon.close();
    ws.close();
    await until(() => listPcs().length === 0);
  });

  it('refuses the CDP endpoint without the key or for an unknown PC', async () => {
    const { ws: pc, id } = await pair('laptop');
    const noKey = await open(`ws://127.0.0.1:${port}/ws/connector/cdp/${id}`);
    expect(await closed(noKey)).toEqual({ code: 4003, reason: 'forbidden' });
    const unknown = await open(cdpUrlFor('nope'));
    expect(await closed(unknown)).toEqual({ code: 4004, reason: 'PC not connected' });
    pc.close();
    await closed(pc);
    await until(() => listPcs().length === 0);
  });

  it('serves the connector script and the status to a logged-in admin only', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/admin/connector' });
    expect(anon.statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: config.auth.user, password: config.auth.pass } });
    const cookie = login.headers['set-cookie'];
    expect(cookie).toBeTruthy();
    const headers = { cookie: String(Array.isArray(cookie) ? cookie[0] : cookie).split(';')[0]! };
    const status = await app.inject({ method: 'GET', url: '/api/admin/connector', headers });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ code: pairingCode(), pcs: [] });
    const script = await app.inject({ method: 'GET', url: '/api/admin/connector/script', headers });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-disposition']).toContain('eab-connect.mjs');
    expect(script.body).toContain("t: 'hello'");
  });
});
