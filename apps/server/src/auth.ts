import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { config } from './config.js';

// Simple single-user session gate. A login sets an HttpOnly, HMAC-signed cookie
// carrying only an expiry; the server re-verifies the signature on every
// request. No DB, no per-user state — just "is this browser holding a valid,
// unexpired, correctly-signed token".

export const SESSION_COOKIE = 'eab_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const cookieSecure = process.env.NODE_ENV === 'production';

let cachedSecret: string | null = null;

function secret(): string {
  if (cachedSecret) return cachedSecret;
  if (config.auth.secret) {
    cachedSecret = config.auth.secret;
    return cachedSecret;
  }
  // Generate + persist a random secret so sessions survive restarts without any
  // manual setup. Lives on the DATA_DIR volume alongside the DB.
  const file = path.join(config.dataDir, 'auth-secret');
  try {
    cachedSecret = fs.readFileSync(file, 'utf-8').trim();
    if (cachedSecret) return cachedSecret;
  } catch {
    /* not created yet */
  }
  cachedSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cachedSecret, { mode: 0o600 });
  } catch {
    /* best-effort; secret stays in memory for this process */
  }
  return cachedSecret;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function createSessionToken(): string {
  const exp = String(Date.now() + MAX_AGE_MS);
  return `${exp}.${sign(exp)}`;
}

function verifySessionToken(token: string): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!timingSafeEqual(mac, sign(exp))) return false;
  const expMs = Number(exp);
  return Number.isFinite(expMs) && expMs > Date.now();
}

export function checkCredentials(username: string, password: string): boolean {
  // Compare both fields in constant time; still return false if either differs.
  const okUser = timingSafeEqual(username, config.auth.user);
  const okPass = timingSafeEqual(password, config.auth.pass);
  return okUser && okPass;
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function isAuthenticated(req: FastifyRequest): boolean {
  if (!config.auth.enabled) return true;
  const token = readCookie(req, SESSION_COOKIE);
  return token != null && verifySessionToken(token);
}

export function sessionSetCookie(token: string): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  ];
  if (cookieSecure) attrs.push('Secure');
  return attrs.join('; ');
}

export function sessionClearCookie(): string {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (cookieSecure) attrs.push('Secure');
  return attrs.join('; ');
}
