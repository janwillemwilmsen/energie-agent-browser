// Block until a TCP port accepts a connection, then exit 0. Used to gate the
// Vite dev server on the API server being up, so the first proxied /api request
// doesn't race the backend and log an ECONNREFUSED "http proxy error".
//
// Usage: node wait-for-port.mjs [port=3011] [host=127.0.0.1] [timeoutMs=30000]
// On timeout it still exits 0 (so running the web dev server standalone isn't
// permanently blocked when no API server is started).
import net from 'node:net';

const port = Number(process.argv[2] ?? 3011);
const host = process.argv[3] ?? '127.0.0.1';
const timeoutMs = Number(process.argv[4] ?? 30_000);
const start = Date.now();

function attempt() {
  const sock = net.connect({ port, host });
  sock.once('connect', () => {
    sock.destroy();
    process.exit(0);
  });
  sock.once('error', () => {
    sock.destroy();
    if (Date.now() - start > timeoutMs) {
      console.warn(`wait-for-port: ${host}:${port} not up after ${timeoutMs}ms — continuing anyway`);
      process.exit(0);
    }
    setTimeout(attempt, 250);
  });
}

console.log(`wait-for-port: waiting for ${host}:${port}…`);
attempt();
