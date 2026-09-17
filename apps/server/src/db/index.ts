import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, 'sqlite.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Install a database handle (tests: an in-memory one). Closes any open one. */
export function setDb(next: Database.Database): void {
  if (db && db !== next) db.close();
  db = next;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
