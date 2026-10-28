// What a caller wants from a browser Session, and the daemon actions that
// get it there. The plan is pure so the ordering rules (close first? wipe
// the persisted state? bind to which name? load that name's state? which
// backend?) live in one tested place instead of in each caller.

import type { BackendKind } from './backend.js';

/**
 * Which browser backend the daemon must drive. Scenario runs always say:
 * `null` is the admin page's active backend, a kind is the Scenario's own
 * override. Omitted = no opinion: a live daemon is kept whatever it drives,
 * and a new one gets the admin default.
 */
interface BackendChoice {
  backend?: BackendKind | null;
}

export type OpenIntent =
  /** Any daemon will do; bootstrap an unnamed one if none is up. */
  | ({ intent: 'reuse' } & BackendChoice)
  /** A brand-new unnamed daemon: empty cookie jar, no binding. */
  | ({ intent: 'fresh' } & BackendChoice)
  /**
   * Bound to a Preflight's name with its persisted state loaded ("already
   * logged in"). Reuses a daemon already bound to that name (re-applying the
   * state), restarts one bound elsewhere.
   */
  | ({ intent: 'bind'; sessionName: string } & BackendChoice)
  /**
   * A genuinely clean daemon bound to the name but WITHOUT its persisted
   * state, for re-running the Preflight's steps from scratch. Always restarts:
   * a reused daemon still holds the previous run's in-memory cookies.
   */
  | ({ intent: 'preflight-steps'; sessionName: string } & BackendChoice)
  /** Like preflight-steps, but the name's persisted state is wiped first. */
  | ({ intent: 'replay'; sessionName: string } & BackendChoice);

export interface SessionState {
  alive: boolean;
  /** The --session-name the live daemon was started with, or null. */
  boundName: string | null;
  /** The backend override the live daemon was started with; null = the admin default. */
  boundBackend?: BackendKind | null;
}

export interface OpenPlan {
  /** Close the live daemon first. */
  close: boolean;
  /** Wipe this name's persisted state before connecting. */
  wipeName: string | null;
  /** Spawn a daemon (bound to `sessionName` when not null). */
  connect: boolean;
  sessionName: string | null;
  /** Load the name's persisted state into the daemon (after connecting, or into the reused one). */
  loadState: boolean;
  /** The backend override to spawn with; null = the admin default. */
  backend: BackendKind | null;
}

export function planOpen(intent: OpenIntent, state: SessionState): OpenPlan {
  const backend = intent.backend ?? null;
  // A live daemon on the wrong backend is as good as dead to a caller with an
  // opinion: it has to be restarted, whatever name it is bound to.
  const wrongBackend = intent.backend !== undefined && state.alive && (state.boundBackend ?? null) !== intent.backend;
  const alive = state.alive && !wrongBackend;
  switch (intent.intent) {
    case 'reuse':
      return alive
        ? { close: false, wipeName: null, connect: false, sessionName: state.boundName, loadState: false, backend }
        : { close: wrongBackend, wipeName: null, connect: true, sessionName: null, loadState: false, backend };
    case 'fresh':
      return { close: state.alive, wipeName: null, connect: true, sessionName: null, loadState: false, backend };
    case 'bind': {
      const name = intent.sessionName;
      if (alive && state.boundName === name) {
        return { close: false, wipeName: null, connect: false, sessionName: name, loadState: true, backend };
      }
      return { close: state.alive, wipeName: null, connect: true, sessionName: name, loadState: true, backend };
    }
    case 'preflight-steps':
      return { close: state.alive, wipeName: null, connect: true, sessionName: intent.sessionName, loadState: false, backend };
    case 'replay':
      return {
        close: state.alive,
        wipeName: intent.sessionName,
        connect: true,
        sessionName: intent.sessionName,
        loadState: false,
        backend,
      };
  }
}
