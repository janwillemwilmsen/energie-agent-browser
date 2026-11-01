import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { config } from '../config.js';
import { getSetting, setSetting } from '../settings.js';
import { decryptSecret, encryptSecret, isEncrypted } from '../secrets.js';

// The connector hub: lets the agent-browser daemon on this server drive a
// Chrome on the user's own PC without the PC opening any port.
//
// The PC runs eab-connect.mjs (served by this server, see ../../connector/),
// which dials OUT to /ws/connector like a browser tab would, authenticates
// with the pairing code from Admin → Browser, and then relays Chrome's
// DevTools protocol: every CDP connection the daemon wants becomes a numbered
// channel on that one socket, and the connector opens a matching WebSocket
// to Chrome's debugger URL on its side.
//
// The daemon side never knows about any of this: it is told to `connect`
// to ws://127.0.0.1:<port>/ws/connector/cdp/<pc> on this very server, a
// loopback-only endpoint guarded by a per-process secret, and the hub pipes
// that socket to a channel.
//
// Wire format, JSON text frames (CDP itself is JSON text, carried as a string):
//   PC → hub   {t:'hello', code, name, platform, version:{browser,userAgent,protocolVersion}}
//   hub → PC   {t:'welcome', id} | {t:'error', message} (then close)
//   hub → PC   {t:'open', ch}            the daemon connected; dial Chrome
//   PC → hub   {t:'opened', ch} | {t:'openfail', ch, error}
//   both       {t:'msg', ch, data} · {t:'close', ch}
//   PC → hub   {t:'version', version}    Chrome changed; version null = nothing
//                                        answers on the PC's port right now
// Keepalive is WebSocket ping/pong from the hub.

export interface PcVersion {
  browser: string | null;
  protocolVersion: string | null;
  userAgent: string | null;
}

export interface PcInfo {
  id: string;
  name: string;
  platform: string;
  connectedAt: string;
  version: PcVersion;
  /** Whether the PC's Chrome answered its last probe; false = paired, but nothing to drive. */
  chromeOk: boolean;
  /** Open CDP channels (daemons currently attached through this PC). */
  channels: number;
}

interface Channel {
  socket: WebSocket;
  ready: boolean;
  /** CDP-side frames that arrived before the PC reported the channel open. */
  queue: string[];
}

interface Pc extends Omit<PcInfo, 'channels'> {
  socket: WebSocket;
  alive: boolean;
  channels: Map<number, Channel>;
  nextCh: number;
}

const pcs = new Map<string, Pc>();

/** Guards the loopback CDP endpoint; new on every server start, never leaves this process. */
const CDP_KEY = crypto.randomBytes(24).toString('base64url');

const PING_INTERVAL_MS = 25_000;
const HELLO_TIMEOUT_MS = 10_000;

// --- Pairing code ------------------------------------------------------------------

const CODE_SETTING = 'connector_pairing_code';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: it is typed by hand
const CODE_GROUPS = 3;
const CODE_GROUP_LEN = 4;

function newCode(): string {
  const bytes = crypto.randomBytes(CODE_GROUPS * CODE_GROUP_LEN);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  const groups: string[] = [];
  for (let i = 0; i < CODE_GROUPS; i++) groups.push(chars.slice(i * CODE_GROUP_LEN, (i + 1) * CODE_GROUP_LEN).join(''));
  return groups.join('-');
}

/** Dashes/case are for humans; both sides compare the bare letters. */
function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The pairing code the connector must present; created on first use, stored encrypted. */
export function pairingCode(): string {
  const raw = getSetting(CODE_SETTING);
  if (raw) {
    try {
      return isEncrypted(raw) ? decryptSecret(raw) : raw;
    } catch {
      /* a blob this key can't open: replace it below */
    }
  }
  return regeneratePairingCode();
}

/** A fresh code; every connector must be restarted with it. Connected PCs stay connected. */
export function regeneratePairingCode(): string {
  const code = newCode();
  setSetting(CODE_SETTING, encryptSecret(code));
  return code;
}

function codeMatches(presented: string): boolean {
  const a = Buffer.from(normalizeCode(presented));
  const b = Buffer.from(normalizeCode(pairingCode()));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A wrong code costs the client a second, and ten wrong codes from one
// address cost it a minute: enough to make guessing 60 bits pointless.
const failures = new Map<string, { count: number; until: number }>();
const FAIL_LIMIT = 10;
const FAIL_BLOCK_MS = 60_000;

function blocked(ip: string): boolean {
  const f = failures.get(ip);
  return !!f && f.count >= FAIL_LIMIT && f.until > Date.now();
}

function noteFailure(ip: string): void {
  const f = failures.get(ip) ?? { count: 0, until: 0 };
  if (f.until < Date.now()) f.count = 0;
  f.count += 1;
  f.until = Date.now() + FAIL_BLOCK_MS;
  failures.set(ip, f);
}

// --- Registry ----------------------------------------------------------------------

export function listPcs(): PcInfo[] {
  return [...pcs.values()]
    .map(({ socket: _s, alive: _a, channels, nextCh: _n, ...info }) => ({ ...info, channels: channels.size }) as PcInfo)
    .sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
}

/**
 * The PC a backend with `name` drives: that name when given, otherwise the
 * most recently connected one. Null when nothing matches.
 */
export function pickPc(name: string): PcInfo | null {
  const all = listPcs();
  if (!name.trim()) return all[0] ?? null;
  const wanted = name.trim().toLowerCase();
  return all.find((p) => p.name.toLowerCase() === wanted) ?? null;
}

/** The loopback URL the daemon `connect`s to for a PC; the hub turns it into a channel. */
export function cdpUrlFor(pcId: string): string {
  return `ws://127.0.0.1:${config.port}/ws/connector/cdp/${encodeURIComponent(pcId)}?key=${CDP_KEY}`;
}

/**
 * The PC for a backend, with a Chrome to drive, or an error that tells the
 * user what to do. A paired PC whose Chrome is gone is refused here, before
 * any daemon starts: a `connect` that fails later kills the daemon and the
 * next command would launch a local browser instead.
 */
export function requirePc(name: string): PcInfo {
  const pc = pickPc(name);
  if (pc) {
    if (!pc.chromeOk) throw new Error(`"${pc.name}" is connected but nothing answers on its Chrome debugging port — start Chrome there (eab-connect restarts it on its own within a few seconds unless it was run with --no-launch).`);
    return pc;
  }
  const have = listPcs();
  if (!have.length) throw new Error('No PC is connected — start eab-connect on your PC (Admin → Browser → Your own PC has the command).');
  throw new Error(`No connected PC is named "${name}" (connected: ${have.map((p) => p.name).join(', ')}).`);
}

function readVersion(v: any): { version: PcVersion; chromeOk: boolean } {
  if (!v || typeof v !== 'object') return { version: { browser: null, protocolVersion: null, userAgent: null }, chromeOk: false };
  return {
    version: { browser: v.browser ?? null, protocolVersion: v.protocolVersion ?? null, userAgent: v.userAgent ?? null },
    chromeOk: true,
  };
}

function send(socket: WebSocket, msg: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function closeChannel(pc: Pc, ch: number, code: number, reason: string, notifyPc: boolean): void {
  const channel = pc.channels.get(ch);
  if (!channel) return;
  pc.channels.delete(ch);
  try { channel.socket.close(code, reason.slice(0, 120)); } catch { /* already gone */ }
  if (notifyPc) send(pc.socket, { t: 'close', ch });
}

function dropPc(pc: Pc, reason: string): void {
  if (pcs.get(pc.id) !== pc) return;
  pcs.delete(pc.id);
  for (const ch of [...pc.channels.keys()]) closeChannel(pc, ch, 1001, reason, false);
}

// --- Routes ------------------------------------------------------------------------

export async function connectorWsRoutes(app: FastifyInstance) {
  // The PC's socket. Not behind the app login (app.ts exempts it): the pairing
  // code is its credential.
  app.get('/ws/connector', { websocket: true }, (socket, req) => {
    const ip = req.ip;
    if (blocked(ip)) {
      socket.close(4029, 'too many wrong pairing codes; try again in a minute');
      return;
    }
    let pc: Pc | null = null;
    const helloTimer = setTimeout(() => { if (!pc) socket.close(4000, 'no hello'); }, HELLO_TIMEOUT_MS);

    socket.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (!pc) {
        if (msg.t !== 'hello' || typeof msg.code !== 'string') return;
        clearTimeout(helloTimer);
        if (!codeMatches(msg.code)) {
          noteFailure(ip);
          setTimeout(() => socket.close(4001, 'wrong pairing code'), 1_000);
          return;
        }
        const name = String(msg.name ?? 'pc').slice(0, 60) || 'pc';
        pc = {
          id: crypto.randomBytes(6).toString('hex'),
          name,
          platform: String(msg.platform ?? '').slice(0, 40),
          connectedAt: new Date().toISOString(),
          ...readVersion(msg.version),
          socket,
          alive: true,
          channels: new Map(),
          nextCh: 1,
        };
        pcs.set(pc.id, pc);
        send(socket, { t: 'welcome', id: pc.id, name });
        app.log.info({ pc: name, id: pc.id, ip, browser: pc.version.browser, chromeOk: pc.chromeOk }, 'connector: PC paired');
        return;
      }

      switch (msg.t) {
        case 'opened': {
          const channel = pc.channels.get(msg.ch);
          if (!channel) return;
          channel.ready = true;
          app.log.info({ pc: pc.name, ch: msg.ch, queued: channel.queue.length }, 'connector: channel open to Chrome');
          for (const data of channel.queue.splice(0)) send(pc.socket, { t: 'msg', ch: msg.ch, data });
          return;
        }
        case 'openfail':
          app.log.warn({ pc: pc.name, ch: msg.ch, error: msg.error }, 'connector: PC could not reach its Chrome');
          closeChannel(pc, msg.ch, 1011, `Chrome on ${pc.name}: ${msg.error ?? 'could not connect'}`, false);
          return;
        case 'msg': {
          const channel = pc.channels.get(msg.ch);
          if (channel && typeof msg.data === 'string' && channel.socket.readyState === channel.socket.OPEN) channel.socket.send(msg.data);
          return;
        }
        case 'close':
          closeChannel(pc, msg.ch, 1000, 'closed by PC', false);
          return;
        case 'version': {
          const was = pc.chromeOk;
          Object.assign(pc, readVersion(msg.version));
          if (was !== pc.chromeOk) app.log.info({ pc: pc.name, browser: pc.version.browser }, pc.chromeOk ? 'connector: Chrome reachable on PC' : 'connector: Chrome gone on PC');
          return;
        }
      }
    });

    socket.on('pong', () => { if (pc) pc.alive = true; });
    const ping = setInterval(() => {
      if (!pc) return;
      if (!pc.alive) { socket.terminate(); return; }
      pc.alive = false;
      try { socket.ping(); } catch { /* closing */ }
    }, PING_INTERVAL_MS);

    socket.on('close', () => {
      clearInterval(ping);
      clearTimeout(helloTimer);
      if (pc) {
        app.log.info({ pc: pc.name, id: pc.id }, 'connector: PC disconnected');
        dropPc(pc, 'PC disconnected');
      }
    });
    socket.on('error', () => { /* close follows */ });
  });

  // The daemon's side: one CDP connection = one channel to the PC. Loopback
  // only, and only with this process's key — through the reverse proxy this
  // path is simply unreachable.
  app.get<{ Params: { id: string }; Querystring: { key?: string } }>(
    '/ws/connector/cdp/:id',
    { websocket: true },
    (socket, req) => {
      if (!isLoopback(req.socket.remoteAddress) || req.query.key !== CDP_KEY) {
        socket.close(4003, 'forbidden');
        return;
      }
      const pc = pcs.get(req.params.id);
      if (!pc) {
        socket.close(4004, 'PC not connected');
        return;
      }
      const ch = pc.nextCh++;
      const channel: Channel = { socket, ready: false, queue: [] };
      pc.channels.set(ch, channel);
      app.log.info({ pc: pc.name, ch }, 'connector: daemon attached, asking PC to dial Chrome');
      send(pc.socket, { t: 'open', ch });

      socket.on('message', (raw) => {
        const data = raw.toString();
        if (channel.ready) send(pc.socket, { t: 'msg', ch, data });
        else channel.queue.push(data);
      });
      socket.on('close', (code) => {
        if (pc.channels.get(ch) === channel) {
          pc.channels.delete(ch);
          app.log.info({ pc: pc.name, ch, code }, 'connector: daemon detached');
          send(pc.socket, { t: 'close', ch });
        }
      });
      socket.on('error', () => { /* close follows */ });
    },
  );
}
