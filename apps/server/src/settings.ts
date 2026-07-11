import { getDb } from './db/index.js';

// Tiny key/value settings store (app_settings table). Values are strings;
// callers own their (de)serialization.

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null): void {
  const db = getDb();
  if (value === null || value === '') {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).run(key, value);
}
