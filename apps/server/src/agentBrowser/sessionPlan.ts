// What a caller wants from a browser Session, and the daemon actions that
// get it there. The plan is pure so the ordering rules (close first? wipe
// the persisted state? bind to which name? load that name's state?) live in
// one tested place instead of in each caller.

export type OpenIntent =
  /** Any daemon will do; bootstrap an unnamed one if none is up. */
  | { intent: 'reuse' }
  /** A brand-new unnamed daemon: empty cookie jar, no binding. */
  | { intent: 'fresh' }
  /**
   * Bound to a Preflight's name with its persisted state loaded ("already
   * logged in"). Reuses a daemon already bound to that name (re-applying the
   * state), restarts one bound elsewhere.
   */
  | { intent: 'bind'; sessionName: string }
  /**
   * A genuinely clean daemon bound to the name but WITHOUT its persisted
   * state, for re-running the Preflight's steps from scratch. Always restarts:
   * a reused daemon still holds the previous run's in-memory cookies.
   */
  | { intent: 'preflight-steps'; sessionName: string }
  /** Like preflight-steps, but the name's persisted state is wiped first. */
  | { intent: 'replay'; sessionName: string };

export interface SessionState {
  alive: boolean;
  /** The --session-name the live daemon was started with, or null. */
  boundName: string | null;
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
}

export function planOpen(intent: OpenIntent, state: SessionState): OpenPlan {
  switch (intent.intent) {
    case 'reuse':
      return state.alive
        ? { close: false, wipeName: null, connect: false, sessionName: state.boundName, loadState: false }
        : { close: false, wipeName: null, connect: true, sessionName: null, loadState: false };
    case 'fresh':
      return { close: state.alive, wipeName: null, connect: true, sessionName: null, loadState: false };
    case 'bind': {
      const name = intent.sessionName;
      if (state.alive && state.boundName === name) {
        return { close: false, wipeName: null, connect: false, sessionName: name, loadState: true };
      }
      return { close: state.alive, wipeName: null, connect: true, sessionName: name, loadState: true };
    }
    case 'preflight-steps':
      return { close: state.alive, wipeName: null, connect: true, sessionName: intent.sessionName, loadState: false };
    case 'replay':
      return {
        close: state.alive,
        wipeName: intent.sessionName,
        connect: true,
        sessionName: intent.sessionName,
        loadState: false,
      };
  }
}
