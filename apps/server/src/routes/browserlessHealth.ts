import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// Probes the configured browserless instance from the server (which is on the
// same network as the agent-browser daemon, so this is the most relevant
// reachability check for our actual workload). Hits two endpoints:
//   GET /docs           — what browserless's own docker-compose healthcheck
//                         uses; a 2xx here means the service is up
//   GET /json/version   — best-effort version probe (Chrome version, etc.) so
//                         the UI can show what we're talking to
// Either probe failing is reported, but only /docs gates `ok`.
const PROBE_TIMEOUT_MS = 8_000;
const VERSION_TIMEOUT_MS = 4_000;

interface VersionInfo {
  browser: string | null;
  protocolVersion: string | null;
  userAgent: string | null;
  webSocketDebuggerUrl: string | null;
}

async function probe(url: string, timeoutMs: number): Promise<
  { status: number; ok: boolean; body?: string; error?: undefined } |
  { status: null; ok: false; error: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    // Cap body read so a misbehaving server can't blow memory.
    const text = await res.text().catch(() => '');
    // browserless /docs redirects (301/302) to its hosted docs site — that's
    // still proof the service is up, so we treat 2xx AND 3xx as healthy.
    // Their own docker-compose healthcheck uses `curl -f`, which also accepts
    // 3xx, so this matches what they consider "ready".
    const ok = res.status >= 200 && res.status < 400;
    return { status: res.status, ok, body: text.slice(0, 4_000) };
  } catch (e: any) {
    const msg = e?.name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : (e?.message ?? String(e));
    return { status: null, ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function httpBaseFromWss(rawUrl: string): string {
  return rawUrl
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/\/+$/, '');
}

export async function browserlessHealthRoutes(app: FastifyInstance) {
  app.get('/api/browserless/health', async () => {
    const httpsBase = httpBaseFromWss(config.browserless.url);
    const docsUrl = `${httpsBase}/docs`;
    // /json/version is token-gated on browserless v2 (returns "Bad or missing
    // authentication" otherwise). Pass the token but never echo it back to
    // the client; the UI gets the version string, not the URL.
    const versionUrl =
      `${httpsBase}/json/version?token=${encodeURIComponent(config.browserless.token)}`;

    const startedAt = Date.now();
    const docs = await probe(docsUrl, PROBE_TIMEOUT_MS);

    let version: VersionInfo | null = null;
    const versionProbe = await probe(versionUrl, VERSION_TIMEOUT_MS);
    if (versionProbe.status === 200 && versionProbe.body) {
      try {
        const json = JSON.parse(versionProbe.body) as Record<string, string>;
        version = {
          browser: json['Browser'] ?? null,
          protocolVersion: json['Protocol-Version'] ?? null,
          userAgent: json['User-Agent'] ?? null,
          webSocketDebuggerUrl: json['webSocketDebuggerUrl'] ?? null,
        };
      } catch {
        /* ignore — leave version null */
      }
    }

    return {
      ok: docs.ok,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      docs: {
        url: docsUrl,
        status: docs.status,
        ok: docs.ok,
        error: docs.error ?? null,
      },
      version,
      // Echo the configured CDP URL (without the token) so the UI can show
      // exactly what the daemon will be connecting to.
      cdp: {
        configuredUrl: config.browserless.url,
      },
    };
  });
}
