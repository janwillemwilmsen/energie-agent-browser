import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromeHttpBase, chromeWsBase, probeChrome, rebaseWsUrl, resolveChromeConnectUrl } from './chromeRemote.js';

// The chrome backend's URL handling against a fake Chrome: the configured
// host:port survives in the connect URL, and /json/version is asked with a
// Host header Chrome accepts.

let server: http.Server | null = null;
afterEach(() => new Promise<void>((resolve) => { server ? server.close(() => resolve()) : resolve(); server = null; }));

function fakeChrome(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });
}

const versionBody = (wsUrl: string) =>
  JSON.stringify({ Browser: 'Chrome/131.0.0.0', 'Protocol-Version': '1.3', 'User-Agent': 'UA', webSocketDebuggerUrl: wsUrl });

describe('chrome URL handling', () => {
  it('keeps only host:port of the configured URL, in both schemes', () => {
    expect(chromeHttpBase('ws://127.0.0.1:9222')).toBe('http://127.0.0.1:9222');
    expect(chromeHttpBase('http://host.docker.internal:9222/')).toBe('http://host.docker.internal:9222');
    expect(chromeHttpBase('wss://pc.example.com:9222/devtools/browser/old-id')).toBe('https://pc.example.com:9222');
    expect(chromeWsBase('http://127.0.0.1:9222')).toBe('ws://127.0.0.1:9222');
    expect(chromeWsBase('https://pc.example.com')).toBe('wss://pc.example.com');
  });

  it('rebases the debugger URL Chrome returns onto the configured host:port', () => {
    // Chrome echoes the Host header it saw (localhost) — through a tunnel that is not where we reach it.
    expect(rebaseWsUrl('http://host.docker.internal:9222', 'ws://localhost/devtools/browser/abc-123'))
      .toBe('ws://host.docker.internal:9222/devtools/browser/abc-123');
    expect(rebaseWsUrl('https://pc.example.com:9222', 'ws://localhost:9222/devtools/browser/abc'))
      .toBe('wss://pc.example.com:9222/devtools/browser/abc');
  });
});

describe('probeChrome', () => {
  it('asks /json/version with a localhost Host header and reports the version + connect URL', async () => {
    let seen: { url?: string; host?: string } = {};
    const base = await fakeChrome((req, res) => {
      seen = { url: req.url, host: req.headers.host };
      res.setHeader('content-type', 'application/json');
      res.end(versionBody('ws://localhost/devtools/browser/the-id'));
    });
    const r = await probeChrome(base, 2_000);
    expect(seen).toEqual({ url: '/json/version', host: 'localhost' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(200);
    expect(r.version.browser).toBe('Chrome/131.0.0.0');
    expect(r.version.webSocketDebuggerUrl).toBe(`${chromeWsBase(base)}/devtools/browser/the-id`);
    await expect(resolveChromeConnectUrl(base)).resolves.toBe(`${chromeWsBase(base)}/devtools/browser/the-id`);
  });

  it('explains a non-Chrome answer and a closed port instead of throwing', async () => {
    const base = await fakeChrome((_req, res) => { res.statusCode = 404; res.end('nope'); });
    const r = await probeChrome(base, 2_000);
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(r.error).toMatch(/HTTP 404 — nope/);

    // Closed port: the fake server is the only thing we know is free once closed.
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const closed = await probeChrome(base, 2_000);
    expect(closed.ok).toBe(false);
    expect(closed.error).toMatch(/connection (refused|reset) — is Chrome running/);
    await expect(resolveChromeConnectUrl(base)).rejects.toThrow(/is not reachable: connection (refused|reset)/);
  });

  it('rejects a JSON answer without a debugger URL', async () => {
    const base = await fakeChrome((_req, res) => { res.end(JSON.stringify({ hello: 'world' })); });
    const r = await probeChrome(base, 2_000);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no webSocketDebuggerUrl/);
  });
});
