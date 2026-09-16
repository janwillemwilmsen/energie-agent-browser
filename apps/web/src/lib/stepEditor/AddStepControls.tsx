import type { ReactNode } from 'react';
import type { SelectorStrategy } from '../api.js';
import type { StepStore } from './store.js';

// The "+ …" buttons that create Steps. Which buttons appear follows from the
// kinds the caller allows and the capabilities it provides; the input dialogs
// are the browser's prompt() for now, funnelled through askText.

export interface AuthProfilesCapability {
  names: string[];
  /** Open the profile manager (no profiles yet, or the user asked for it). */
  onManage: () => void;
}

export interface AddStepControlsProps {
  store: StepStore;
  /** Step kinds this editor may create. */
  kinds: readonly string[];
  /** When given, "+ navigate" adds this URL directly instead of prompting. */
  defaultUrl?: string;
  /** Enables "+ auth login". */
  authProfiles?: AuthProfilesCapability;
  /** A reason the add controls are disabled (shown as the buttons' title). */
  disabledReason?: string | null;
  onError?: (message: string) => void;
  /** Extra page-specific buttons rendered after the step buttons. */
  children?: ReactNode;
}

function askText(message: string, defaultValue?: string): string | null {
  return window.prompt(message, defaultValue);
}

// The by-selector dialog: kinds that take a selector, in the order the prompt lists them.
const SELECTOR_KINDS = ['click', 'fill', 'type', 'select', 'check', 'uncheck', 'wait', 'scroll'] as const;

export function AddStepControls(props: AddStepControlsProps) {
  const { store, kinds, defaultUrl, authProfiles, disabledReason, onError, children } = props;
  const allowed = new Set(kinds);
  const disabled = store.busy || !!disabledReason;
  const title = (t?: string) => disabledReason ?? t;
  const add = (kind: string, payload: Record<string, unknown>) => void store.add(kind, payload);

  const selectorKinds = SELECTOR_KINDS.filter((k) => allowed.has(k));

  function addBySelector() {
    // Precise targeting when several elements share a role+name: any
    // agent-browser locator, handed to the CLI verbatim.
    const locator = askText(
      'Locator (agent-browser syntax):\n' +
        '  #id   .class   div > button   [data-testid="x"]   text=Submit   xpath=//button[@type="submit"]',
    );
    if (locator == null || !locator.trim()) return;
    if (locator.trim().startsWith('@')) {
      alert(
        '"@eN" is a snapshot ref, not a selector: agent-browser renumbers elements on every snapshot/navigation, so it cannot be replayed later.\n' +
          'Use the click/type buttons on the snapshot row instead (they re-find the element by role + name each run), or enter a stable locator (#id, [data-testid=…], CSS, text=, xpath=).',
      );
      return;
    }
    const action = (askText(`Action? ${selectorKinds.join(' / ')}`, selectorKinds[0]) ?? '')
      .trim()
      .toLowerCase();
    if (!selectorKinds.includes(action as (typeof SELECTOR_KINDS)[number])) {
      alert('Unknown action');
      return;
    }
    const selector: SelectorStrategy = { role: '', name: '', locator: locator.trim() };
    if (action === 'fill') {
      const value = askText('Fill with?');
      if (value != null) add('fill', { selector, value });
    } else if (action === 'type') {
      const text = askText('Type what?');
      if (text != null) add('type', { selector, text });
    } else if (action === 'select') {
      const value = askText('Select which option? (option label)');
      if (value != null && value.trim()) add('select', { selector, value: value.trim() });
    } else {
      add(action, { selector });
    }
  }

  function addNavigate() {
    if (defaultUrl) {
      add('navigate', { url: defaultUrl });
      return;
    }
    const url = askText('Navigate to URL?');
    if (url) add('navigate', { url });
  }

  function addWait() {
    const raw = askText('Wait how many milliseconds?', '1000');
    if (raw == null) return;
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) {
      alert('Must be a positive integer');
      return;
    }
    add('wait', { ms: Math.floor(ms) });
  }

  function addAuthLogin() {
    if (!authProfiles) return;
    if (authProfiles.names.length === 0) {
      authProfiles.onManage();
      return;
    }
    const choice = askText(
      'Which auth profile? Available: ' +
        authProfiles.names.join(', ') +
        '\n\n(type one of the names above, or leave blank to manage profiles)',
    );
    if (choice == null) return;
    const trimmed = choice.trim();
    if (!trimmed) {
      authProfiles.onManage();
      return;
    }
    if (!authProfiles.names.includes(trimmed)) {
      onError?.(`No auth profile named "${trimmed}". Manage profiles below.`);
      authProfiles.onManage();
      return;
    }
    add('auth-login', { name: trimmed });
  }

  const screenshotLabel = () => `step-${store.steps.length}`;

  return (
    <div className="actions">
      {allowed.has('navigate') && (
        <button onClick={addNavigate} disabled={disabled} title={title()}>
          + navigate{defaultUrl ? ` (${defaultUrl})` : ''}
        </button>
      )}
      {selectorKinds.length > 0 && (
        <button
          onClick={addBySelector}
          disabled={disabled}
          title={title('Add a step that targets an element by a precise locator (#id, CSS, [data-testid], text=, xpath=) instead of role+name')}
        >
          + by selector…
        </button>
      )}
      {allowed.has('screenshot') && (
        <>
          <button onClick={() => add('screenshot', { label: screenshotLabel(), fullPage: true })} disabled={disabled} title={title()}>
            + screenshot (full page)
          </button>
          <button onClick={() => add('screenshot', { label: screenshotLabel(), fullPage: false })} disabled={disabled} title={title()}>
            + screenshot (viewport)
          </button>
          <button
            onClick={() => add('screenshot', { label: screenshotLabel(), fullPage: true, viewport: 'mobile' })}
            disabled={disabled}
            title={title('Switch to the mobile device, capture a full-page screenshot, then restore the viewport')}
          >
            + screenshot (mobile)
          </button>
          <button
            onClick={() => add('screenshot', { label: screenshotLabel(), fullPage: true, annotate: true })}
            disabled={disabled}
            title={title('Full-page screenshot with numbered labels overlaid on interactive elements (legend in the run log)')}
          >
            + screenshot (annotated)
          </button>
        </>
      )}
      {allowed.has('scroll') && (
        <>
          <button
            onClick={() => add('scroll', { toBottom: true })}
            disabled={disabled}
            title={title('Scroll the page to the bottom in strides so lazy-loaded images fire')}
          >
            + scroll to bottom
          </button>
          <button
            onClick={() => add('scroll', { toTop: true })}
            disabled={disabled}
            title={title('Jump back to the top of the page (useful before targeting a header element)')}
          >
            + scroll to top
          </button>
        </>
      )}
      {allowed.has('wait') && (
        <button onClick={addWait} disabled={disabled} title={title()}>
          + wait (ms)
        </button>
      )}
      {allowed.has('record_start') && (
        <button
          onClick={() => add('record_start', {})}
          disabled={disabled}
          title={title('Start a video recording from this point in the scenario (drag to position; saved to the Recordings page)')}
        >
          + ⏺ start recording
        </button>
      )}
      {allowed.has('record_stop') && (
        <button onClick={() => add('record_stop', {})} disabled={disabled} title={title('Stop the video recording and save it')}>
          + ⏹ stop recording
        </button>
      )}
      {allowed.has('close') && (
        <button
          onClick={() => add('close', {})}
          disabled={disabled}
          title={title('Close the browser session (agent-browser close) — useful as a final step to end the scenario cleanly')}
        >
          + ✕ close session
        </button>
      )}
      {allowed.has('auth-login') && authProfiles && (
        <button
          onClick={addAuthLogin}
          disabled={disabled}
          title={title('Single-step encrypted login using a saved auth profile')}
        >
          + auth login
        </button>
      )}
      {children}
    </div>
  );
}
