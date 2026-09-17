import type { PreflightMode, ViewportPreset } from './schemas.js';

// Row shapes as the server actually returns them. These are plain types, not
// schemas: the server never validates its own responses, and a schema nobody
// parses with only drifts. Field notes describe what the API sends.

export interface Scenario {
  id: number;
  name: string;
  url: string;
  viewport_preset: ViewportPreset;
  brand: string | null;
  type: string | null;
  retries: number;
  retry_wait_before_ms: number;
  retry_wait_after_ms: number;
  restart_on_failure: number;
  /** FK to preflights(id); the run binds the browser session to that preflight's name. */
  preflight_id: number | null;
  preflight_mode: PreflightMode;
  /** 0/1 (sqlite boolean). */
  record_enabled: number;
  created_at: string;
  updated_at: string;
}

export interface Preflight {
  id: number;
  name: string;
  description: string;
  /** JSON array of PreflightStep. */
  steps_json: string;
  retries: number;
  retry_wait_before_ms: number;
  retry_wait_after_ms: number;
  restart_on_failure: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Mirror of `agent-browser auth list` / `auth show`; passwords never leave the vault. */
export interface AuthProfile {
  name: string;
  url: string;
  username: string;
  /** Optional CSS selector overrides applied at `auth login` time; kept by this app. */
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}

export interface Schedule {
  id: number;
  scenario_id: number;
  /** Ordered chain of scenarios this schedule runs sequentially. */
  scenario_ids: number[];
  cron_expr: string;
  /** 0/1 from sqlite; a boolean when freshly written. */
  enabled: 0 | 1 | boolean;
  last_run_at: string | null;
  last_status: string | null;
}

export type RunStatus = 'queued' | 'running' | 'success' | 'failed';

export interface Run {
  id: number;
  scenario_id: number;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  log_text: string;
  /** JSON array of screenshot slot filenames (see slots.ts). */
  screenshot_paths_json: string;
  /** Joined from the scenario by the list endpoints; absent on the single-run endpoint. */
  scenario_name?: string | null;
  brand?: string | null;
  type?: string | null;
}
