import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Per-profile CSS selector overrides for the auth vault.
//
// agent-browser's `auth save` only persists name/url/username/password — it has
// no way to store selectors (they're accepted only on `auth login`, as a
// per-login override). So we keep them ourselves in a small sidecar next to the
// rest of our data, keyed by profile name, and re-apply them whenever an
// `auth-login` step runs. Lives under DATA_DIR (a mounted volume in prod) so it
// survives restarts alongside the SQLite DB.
export interface AuthSelectors {
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}

function file(): string {
  return path.join(config.dataDir, 'auth-selectors.json');
}

function readAll(): Record<string, AuthSelectors> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, AuthSelectors>) : {};
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, AuthSelectors>): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(data, null, 2));
}

export function getAuthSelectors(name: string): AuthSelectors {
  return readAll()[name] ?? {};
}

// Store only the non-empty selectors. An entry with none is removed so the
// sidecar doesn't accumulate empty objects.
export function setAuthSelectors(name: string, sel: AuthSelectors): void {
  const all = readAll();
  const clean: AuthSelectors = {};
  if (sel.usernameSelector) clean.usernameSelector = sel.usernameSelector;
  if (sel.passwordSelector) clean.passwordSelector = sel.passwordSelector;
  if (sel.submitSelector) clean.submitSelector = sel.submitSelector;
  if (Object.keys(clean).length === 0) delete all[name];
  else all[name] = clean;
  writeAll(all);
}

export function deleteAuthSelectors(name: string): void {
  const all = readAll();
  if (name in all) {
    delete all[name];
    writeAll(all);
  }
}
