import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, loadDotenv } from '../config.js';
import type { Database } from 'better-sqlite3';
import { getDb } from './index.js';

export function migrate(db: Database = getDb(), migrationsDir: string = config.migrationsDir): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  if (!fs.existsSync(migrationsDir)) {
    console.log(`No migrations directory at ${migrationsDir} — skipping.`);
    return;
  }

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((r: any) => r.name),
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    });
    tx();
    console.log(`Applied migration: ${file}`);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  loadDotenv();
  migrate();
  console.log('Migrations complete.');
}
