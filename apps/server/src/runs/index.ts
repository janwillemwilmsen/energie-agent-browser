import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { createRunStore, type RunStore } from './store.js';

export * from './store.js';

let instance: RunStore | null = null;

/** Forget the app's Run store so the next call builds one over the current db and config. */
export function resetRunStore(): void {
  instance = null;
}

/** The Run store over the app's sqlite file and data directory. */
export function runStore(): RunStore {
  if (!instance) instance = createRunStore({ db: getDb(), dataDir: config.dataDir });
  return instance;
}
