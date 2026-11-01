import http from 'node:http';
import https from 'node:https';

// The `chrome` backend: a Chrome the user started themselves with
// --remote-debugging-port, usually on their own PC, reached from this server
// over a tunnel. agent-browser's `connect` needs the browser's full WebSocket
// URL (ws://host:port/devtools/browser/<id>); a bare port only works for
// localhost. The <id> changes every time Chrome restarts, so the admin page
// stores just host:port and this module asks Chrome's /json/version for the
// current id right before each connect.
//
// Two Chrome quirks shape the code:
//   - Chrome answers /json/* only when the Host header is localhost or an IP
//     ("Host header is specified and is not an IP address or localhost").
//     Through a tunnel the configured host may be a name (host.docker.internal,
//     my-pc.example.com), so the request always carries Host: localhost. The
//     WebSocket handshake itself has no such check.
//   - The webSocketDebuggerUrl Chrome returns echoes the Host it saw, so it
//     says localhost even when we reached it through a tunnel. Only its path
//     is used; the host:port stays the configured one.

export interface ChromeVersion {
  browser: string | null;
  protocolVersion: string | null;
  userAgent: string | null;
  /** The browser's WebSocket URL rebased onto the configured host:port — what `connect` gets. */
  webSocketDebuggerUrl: string | null;
}

/** http(s)://host:port for a configured ws(s)/http(s) URL; any path is dropped. */
export function chromeHttpBase(url: string): string {
  const u = new URL(url);
  const secure = u.protocol === 'wss:' || u.protocol === 'https:';
  return `${secure ? 'https' : 'http'}://${u.host}`;
}

/** ws(s)://host:port for a configured URL (the scheme agent-browser connects with). */
export function chromeWsBase(url: string): string {
  const u = new URL(url);
  const secure = u.protocol === 'wss:' || u.protocol === 'https:';
  return `${secure ? 'wss' : 'ws'}://${u.host}`;
}

/** Chrome's webSocketDebuggerUrl with its host:port replaced by the configured one. */
export function rebaseWsUrl(configured: string, webSocketDebuggerUrl: string): string {
  const base = new URL(chromeWsBase(configured));
  const ws = new URL(webSocketDebuggerUrl);
  base.pathname = ws.pathname;
  base.search = ws.search;
  return base.toString();
}

export type ChromeProbe =
  | { ok: true; status: number; latencyMs: number; version: ChromeVersion; error: null }
  | { ok: false; status: number | null; latencyMs: number; version: null; error: string };

/**
 * GET /json/version on the configured Chrome. Never throws: the admin page
 * shows the failure next to the status badge.
 */
export function probeChrome(url: string, timeoutMs: number): Promise<ChromeProbe> {
  const startedAt = Date.now();
  const done = (r: Omit<ChromeProbe, 'latencyMs'>): ChromeProbe => ({ ...r, latencyMs: Date.now() - startedAt }) as ChromeProbe;
  const fail = (error: string, status: number | null = null) => done({ ok: false, status, version: null, error });
  let base: URL;
  try {
    base = new URL(`${chromeHttpBase(url)}/json/version`);
  } catch {
    return Promise.resolve(fail('not a valid URL'));
  }
  const client = base.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = client.request(
      base,
      {
        method: 'GET',
        // See the header comment: Chrome refuses /json/* for a non-local Host.
        headers: { host: 'localhost', accept: 'application/json' },
        timeout: timeoutMs,
        // A fresh socket per probe: a pooled one to a Chrome/tunnel that went
        // away since meanwhile reports ECONNRESET instead of the real state.
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { if (body.length < 16_000) body += chunk; });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status !== 200) return resolve(fail(`HTTP ${status}${body ? ` — ${body.trim().slice(0, 200)}` : ''}`, status));
          try {
            const json = JSON.parse(body) as Record<string, string>;
            const wsUrl = json['webSocketDebuggerUrl'];
            if (!wsUrl) return resolve(fail('/json/version has no webSocketDebuggerUrl — is this a Chrome remote-debugging port?', status));
            resolve(done({
              ok: true,
              status,
              error: null,
              version: {
                browser: json['Browser'] ?? null,
                protocolVersion: json['Protocol-Version'] ?? null,
                userAgent: json['User-Agent'] ?? null,
                webSocketDebuggerUrl: rebaseWsUrl(url, wsUrl),
              },
            }));
          } catch {
            resolve(fail('/json/version did not return JSON — is this a Chrome remote-debugging port?', status));
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error(`timed out after ${timeoutMs}ms`)); });
    req.on('error', (e: NodeJS.ErrnoException) => {
      const why =
        e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET'
          ? `connection ${e.code === 'ECONNRESET' ? 'reset' : 'refused'} — is Chrome running with --remote-debugging-port, and is the tunnel up?`
          : e.code === 'ENOTFOUND' ? `host not found (${base.hostname})`
            : e.message;
      resolve(fail(why));
    });
    req.end();
  });
}

const RESOLVE_TIMEOUT_MS = 5_000;

// The last successful lookup, so the sync env builder (backendEnv) can put the
// endpoint on every command without a network round-trip. Chrome's browser id
// changes when it restarts, so every bootstrap refreshes this.
let lastResolved: { configured: string; ws: string } | null = null;

/** The WebSocket URL for `--cdp`, looked up now; throws a message fit for the UI when Chrome is unreachable. */
export async function resolveChromeConnectUrl(url: string): Promise<string> {
  const r = await probeChrome(url, RESOLVE_TIMEOUT_MS);
  if (!r.ok) throw new Error(`Chrome at ${chromeHttpBase(url)} is not reachable: ${r.error}`);
  const ws = r.version.webSocketDebuggerUrl!;
  lastResolved = { configured: url, ws };
  return ws;
}

/** What the last bootstrap resolved for `url`, or null when it has not been looked up yet. */
export function cachedChromeConnectUrl(url: string): string | null {
  return lastResolved && lastResolved.configured === url ? lastResolved.ws : null;
}
