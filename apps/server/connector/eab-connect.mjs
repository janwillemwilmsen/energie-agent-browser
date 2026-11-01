#!/usr/bin/env node
// eab-connect — lets a hosted energie-agent-browser drive the Chrome on THIS
// computer. Nothing to install (Node 22+ only), no ports to open: this script
// dials out to the app the way a browser tab does, and relays Chrome's
// DevTools protocol over that connection. Leave it running while you use the
// app; Ctrl+C stops it (Chrome stays open).
//
//   node eab-connect.mjs https://your-app.example.com ABCD-EFGH-JKLM
//
//   --port 9222      Chrome's remote-debugging port (default 9222)
//   --name <name>    how this PC shows up in the app (default: hostname)
//   --no-launch      never start Chrome; only use one already running
//   --profile <dir>  Chrome profile dir to launch with (default ~/.eab-chrome)
//
// If nothing answers on the port, Chrome is started for you with
// --remote-debugging-port in its own profile (Chrome 136+ refuses the flag on
// the normal profile). Log in to the sites you need in that window once.
//
// Protocol (JSON text frames), mirrored in apps/server/src/connector/hub.ts:
//   → {t:'hello', code, name, platform, version}   ← {t:'welcome', id, name}
//   ← {t:'open', ch}   → {t:'opened', ch} | {t:'openfail', ch, error}
//   ↔ {t:'msg', ch, data, more?} · {t:'close', ch} → {t:'version', version|null}
// A big CDP message (a full-page screenshot is 4-11 MB of PNG, so ~6-15 MB of
// base64) is split across several `msg` frames, each but the last carrying
// `more: true`. One giant frame would block this socket's pong behind a
// multi-megabyte upload — the app's keepalive then drops us mid-screenshot.
// Chrome is probed every few seconds while paired, so the app knows when it is
// gone (and refuses to start a run on this PC until it is back) rather than
// finding out mid-connect; when allowed, it is started again on its own.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '1.2.0';
/** Split a CDP message above this into `more` frames (see the protocol note above). */
const CHUNK_BYTES = 256 * 1024;

// --- Arguments -----------------------------------------------------------------------

function usage(exit = 0) {
  console.log('Usage: node eab-connect.mjs <app-url> <pairing-code> [--port 9222] [--name <pc-name>] [--no-launch] [--profile <dir>]');
  process.exit(exit);
}

const opts = { port: 9222, name: os.hostname(), launch: true, profile: path.join(os.homedir(), '.eab-chrome') };
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => { const v = argv[++i]; if (v === undefined) usage(2); return v; };
  if (a === '--help' || a === '-h') usage();
  else if (a === '--port') opts.port = Number(value());
  else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
  else if (a === '--name') opts.name = value();
  else if (a.startsWith('--name=')) opts.name = a.slice(7);
  else if (a === '--no-launch') opts.launch = false;
  else if (a === '--profile') opts.profile = value();
  else if (a.startsWith('--profile=')) opts.profile = a.slice(10);
  else if (a.startsWith('-')) { console.error(`Unknown option ${a}`); usage(2); }
  else positional.push(a);
}
if (positional.length !== 2) usage(2);
if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) { console.error('--port must be a port number'); process.exit(2); }

const [appUrlArg, code] = positional;
if (typeof WebSocket === 'undefined' || typeof fetch === 'undefined') {
  console.error(`This needs Node 22 or newer (you have ${process.version}). https://nodejs.org`);
  process.exit(2);
}
let hubUrl;
try {
  const u = new URL(/^[a-z]+:\/\//i.test(appUrlArg) ? appUrlArg : `https://${appUrlArg}`);
  u.protocol = u.protocol === 'http:' || u.protocol === 'ws:' ? 'ws:' : 'wss:';
  u.pathname = '/ws/connector';
  u.search = '';
  u.hash = '';
  hubUrl = u.toString();
} catch {
  console.error(`Not a valid app URL: ${appUrlArg}`);
  process.exit(2);
}

const log = (...args) => console.log(new Date().toLocaleTimeString(), ...args);

// --- Chrome ---------------------------------------------------------------------------

const versionUrl = `http://127.0.0.1:${opts.port}/json/version`;

/** Chrome's /json/version, or null when nothing answers on the port. */
async function chromeVersion() {
  try {
    const res = await fetch(versionUrl, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.webSocketDebuggerUrl) return null;
    return {
      browser: json.Browser ?? null,
      protocolVersion: json['Protocol-Version'] ?? null,
      userAgent: json['User-Agent'] ?? null,
      webSocketDebuggerUrl: json.webSocketDebuggerUrl,
    };
  } catch {
    return null;
  }
}

function chromeCandidates() {
  const env = process.env;
  switch (process.platform) {
    case 'win32':
      return [
        path.join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ].filter((p) => p && fs.existsSync(p));
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ].filter((p) => fs.existsSync(p));
    default:
      // Resolved through PATH by spawn.
      return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  }
}

/** Start Chrome with remote debugging in its own profile; true when a process was spawned. */
function launchChrome() {
  const args = [
    `--remote-debugging-port=${opts.port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${opts.profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
  for (const exe of chromeCandidates()) {
    try {
      const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => { /* tried the next candidate already or reported below */ });
      child.unref();
      log(`Started ${path.basename(exe)} with remote debugging on port ${opts.port} (profile ${opts.profile})`);
      return true;
    } catch {
      /* next candidate */
    }
  }
  return false;
}

/** Chrome's version info, starting Chrome when allowed; null when none can be had right now. */
async function ensureChrome() {
  let v = await chromeVersion();
  if (v) return v;
  if (!opts.launch) return null;
  if (!launchChrome()) {
    log(`No Chrome found to start. Start one yourself: chrome --remote-debugging-port=${opts.port} --remote-allow-origins=* --user-data-dir=${opts.profile}`);
    return null;
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    v = await chromeVersion();
    if (v) return v;
  }
  log(`Chrome was started but port ${opts.port} is not answering. Close every Chrome window and try again (an already-running Chrome swallows the command).`);
  return null;
}

// --- Relay -----------------------------------------------------------------------------

const publicVersion = (v) => (v ? { browser: v.browser, protocolVersion: v.protocolVersion, userAgent: v.userAgent } : null);

/** One connection to the hub; resolves with 'retry' or 'stop' when it ends. */
function connectOnce(version) {
  return new Promise((resolve) => {
    const hub = new WebSocket(hubUrl);
    const channels = new Map(); // ch → { chrome, ready, queue }
    let lastBrowser = version.browser; // null while nothing answers on the port
    const sendHub = (msg) => { if (hub.readyState === WebSocket.OPEN) hub.send(JSON.stringify(msg)); };
    // One CDP message to the app, split into `more` frames when it is big.
    const sendChannelData = (ch, data) => {
      if (data.length <= CHUNK_BYTES) { sendHub({ t: 'msg', ch, data }); return; }
      for (let i = 0; i < data.length; i += CHUNK_BYTES) {
        const part = data.slice(i, i + CHUNK_BYTES);
        if (i + CHUNK_BYTES < data.length) sendHub({ t: 'msg', ch, data: part, more: true });
        else sendHub({ t: 'msg', ch, data: part });
      }
    };

    // Tell the hub when Chrome appears, changes or disappears; restart it when it is gone.
    const report = (v) => {
      const browser = v ? v.browser : null;
      if (browser === lastBrowser) return;
      lastBrowser = browser;
      sendHub({ t: 'version', version: publicVersion(v) });
      log(v ? `Chrome reachable: ${v.browser}` : `Chrome is gone from port ${opts.port} — runs on this PC are refused until it is back`);
    };
    let probing = false;
    const probe = setInterval(async () => {
      if (probing || hub.readyState !== WebSocket.OPEN) return;
      probing = true;
      try {
        let v = await chromeVersion();
        if (!v && opts.launch && channels.size === 0) v = await ensureChrome();
        report(v);
      } finally {
        probing = false;
      }
    }, 5_000);

    hub.onopen = () => {
      sendHub({ t: 'hello', code, name: opts.name, platform: `${process.platform} node ${process.version}`, version: publicVersion(version), connector: VERSION, chunks: true });
    };

    hub.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      switch (msg.t) {
        case 'welcome':
          log(`Paired with ${appUrlArg} as "${msg.name}". Leave this window open; Ctrl+C to stop.`);
          return;
        case 'open': {
          const ch = msg.ch;
          const v = await chromeVersion();
          report(v);
          if (!v) {
            log(`App asked for a browser session but nothing answers on port ${opts.port}.`);
            sendHub({ t: 'openfail', ch, error: `nothing answers on port ${opts.port} — is Chrome still running?` });
            return;
          }
          const entry = { chrome: null, ready: false, queue: [], inbound: [] };
          channels.set(ch, entry);
          let chrome;
          try {
            chrome = new WebSocket(v.webSocketDebuggerUrl);
          } catch (e) {
            channels.delete(ch);
            sendHub({ t: 'openfail', ch, error: e?.message ?? String(e) });
            return;
          }
          entry.chrome = chrome;
          chrome.onopen = () => {
            entry.ready = true;
            log(`App session #${ch} attached to Chrome (${channels.size} open).`);
            sendHub({ t: 'opened', ch });
            for (const data of entry.queue.splice(0)) chrome.send(data);
          };
          chrome.onmessage = (e) => sendChannelData(ch, String(e.data));
          chrome.onerror = () => {
            if (!entry.ready && channels.get(ch) === entry) {
              channels.delete(ch);
              log(`App session #${ch}: Chrome refused the DevTools connection.`);
              sendHub({ t: 'openfail', ch, error: 'Chrome refused the DevTools connection (start it with --remote-allow-origins=*)' });
            }
          };
          chrome.onclose = () => {
            if (channels.get(ch) === entry) {
              channels.delete(ch);
              log(`App session #${ch}: Chrome closed the connection.`);
              sendHub({ t: 'close', ch });
            }
          };
          return;
        }
        case 'msg': {
          const entry = channels.get(msg.ch);
          if (!entry || typeof msg.data !== 'string') return;
          if (msg.more === true) { entry.inbound.push(msg.data); return; }
          let full = msg.data;
          if (entry.inbound.length) { entry.inbound.push(msg.data); full = entry.inbound.join(''); entry.inbound.length = 0; }
          if (entry.ready) entry.chrome.send(full);
          else entry.queue.push(full);
          return;
        }
        case 'close': {
          const entry = channels.get(msg.ch);
          if (!entry) return;
          channels.delete(msg.ch);
          log(`App session #${msg.ch} ended (${channels.size} open).`);
          try { entry.chrome?.close(); } catch { /* ignore */ }
          return;
        }
      }
    };

    hub.onerror = () => { /* onclose follows with the reason */ };
    hub.onclose = (ev) => {
      clearInterval(probe);
      for (const entry of channels.values()) { try { entry.chrome?.close(); } catch { /* ignore */ } }
      channels.clear();
      // 4xxx codes are the hub's verdicts; anything else is the network.
      if (ev.code === 4001) { log(`The app rejected the pairing code "${code}". Copy the current one from Admin → Browser → Your own PC.`); resolve('stop'); return; }
      if (ev.code === 4029) { log('Too many wrong pairing codes from this address; wait a minute, then check the code.'); resolve('stop'); return; }
      if (ev.code === 4003) { log('Forbidden.'); resolve('stop'); return; }
      log(`Disconnected from ${appUrlArg}${ev.reason ? ` (${ev.reason})` : ''}; reconnecting…`);
      resolve('retry');
    };
  });
}

async function main() {
  log(`eab-connect ${VERSION} → ${hubUrl}`);
  let backoff = 2_000;
  for (;;) {
    let version = await ensureChrome();
    while (!version) {
      log(`Waiting for Chrome on port ${opts.port}…`);
      await new Promise((r) => setTimeout(r, 5_000));
      version = await ensureChrome();
    }
    const started = Date.now();
    const outcome = await connectOnce(version);
    if (outcome === 'stop') process.exit(1);
    // A connection that held for a while resets the backoff.
    backoff = Date.now() - started > 60_000 ? 2_000 : Math.min(backoff * 2, 30_000);
    await new Promise((r) => setTimeout(r, backoff));
  }
}

process.on('SIGINT', () => { log('Stopped. Chrome stays open.'); process.exit(0); });
main().catch((e) => { console.error(e); process.exit(1); });
