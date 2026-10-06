import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Encryption at rest for settings that hold credentials (browser provider API
// keys, tokens). AES-256-GCM; the ciphertext is self-describing so the format
// can change later without a migration:
//
//   enc1:<iv b64>:<auth tag b64>:<ciphertext b64>
//
// The key is SECRETS_KEY (64 hex chars) when set, else a random one generated
// once and kept at DATA_DIR/secrets-key next to the database — the same
// arrangement as the auth signing secret. Note what that does and doesn't buy:
// a copied database file or backup is useless without the key file, but
// anyone with full access to the server (and so to both) can read the values.
// Set SECRETS_KEY from a secret store to keep the key off the data volume.

const PREFIX = 'enc1';
const KEY_FILE = 'secrets-key';

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.SECRETS_KEY?.trim();
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) throw new Error('SECRETS_KEY must be 64 hex characters (32 bytes)');
    cachedKey = Buffer.from(fromEnv, 'hex');
    return cachedKey;
  }
  const file = path.join(config.dataDir, KEY_FILE);
  try {
    const hex = fs.readFileSync(file, 'utf-8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      cachedKey = Buffer.from(hex, 'hex');
      return cachedKey;
    }
  } catch {
    /* not created yet */
  }
  cachedKey = crypto.randomBytes(32);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, cachedKey.toString('hex'), { mode: 0o600 });
  return cachedKey;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':');
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(`${PREFIX}:`);
}

/** Throws when the value was encrypted with a different key or was tampered with. */
export function decryptSecret(value: string): string {
  const [prefix, iv, tag, body] = value.split(':');
  if (prefix !== PREFIX || !iv || !tag || !body) throw new Error('not an encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf-8');
}

/** Tests only: use this key instead of the env/file one. */
export function _setSecretsKeyForTests(k: Buffer | null): void {
  cachedKey = k;
}
