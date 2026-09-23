import type { ReactNode } from 'react';
import type { FindBy, FindLocator, SelectorStrategy } from '../api.js';
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
  /** Whether a `wait` may target a selector (Preflight waits are time-only). Default true. */
  selectorWait?: boolean;
  onError?: (message: string) => void;
  /** Extra page-specific buttons rendered after the step buttons. */
  children?: ReactNode;
}

function askText(message: string, defaultValue?: string): string | null {
  return window.prompt(message, defaultValue);
}

// The by-selector dialog: kinds that take a selector, in the order the prompt lists them.
const SELECTOR_KINDS = ['click', 'fill', 'type', 'select', 'check', 'uncheck', 'wait', 'scroll'] as const;

// The find dialog: `agent-browser find` only offers click / fill / check (and
// the executor polls its `text` action for wait), so the choice is narrower.
const FIND_KINDS = ['click', 'fill', 'check', 'wait'] as const;
const FIND_BY: readonly FindBy[] = ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid'];

export function AddStepControls(props: AddStepControlsProps) {
  const { store, kinds, defaultUrl, authProfiles, disabledReason, onError, children } = props;
  const selectorWait = props.selectorWait ?? true;
  const allowed = new Set(kinds);
  const disabled = store.busy || !!disabledReason;
  const title = (t?: string) => disabledReason ?? t;
  const add = (kind: string, payload: Record<string, unknown>) => void store.add(kind, payload);

  const selectorKinds = SELECTOR_KINDS.filter((k) => allowed.has(k) && (k !== 'wait' || selectorWait));
  const findKinds = FIND_KINDS.filter((k) => allowed.has(k) && (k !== 'wait' || selectorWait));

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

  function addByFind() {
    // agent-browser's semantic locators (getByRole / getByLabel / …): the
    // browser tool resolves them in the live page, so they see through shadow
    // DOM and match names loosely — handy when the a11y-tree name carries
    // invisible glyphs, or a label isn't associated with its input.
    const byRaw = (askText(`Find by? ${FIND_BY.join(' / ')}`, 'role') ?? '').trim().toLowerCase();
    if (!byRaw) return;
    if (!FIND_BY.includes(byRaw as FindBy)) {
      alert(`Unknown find strategy "${byRaw}". Use one of: ${FIND_BY.join(', ')}`);
      return;
    }
    const by = byRaw as FindBy;
    const value = askText(
      by === 'role' ? 'Role? (button, checkbox, textbox, link, heading, …)'
      : by === 'testid' ? 'data-testid value?'
      : `${by[0]!.toUpperCase()}${by.slice(1)} text?`,
    );
    if (value == null || !value.trim()) return;
    const find: FindLocator = { by, value: value.trim() };
    if (by === 'role') {
      const name = askText('Accessible name? (case-insensitive substring; leave blank for any)');
      if (name == null) return;
      if (name.trim()) find.name = name.trim();
    }
    if ((askText('Exact, case-sensitive match? (y/N)', 'n') ?? 'n').trim().toLowerCase().startsWith('y')) {
      find.exact = true;
    }
    const action = (askText(`Action? ${findKinds.join(' / ')}`, findKinds[0]) ?? '').trim().toLowerCase();
    if (!findKinds.includes(action as (typeof FIND_KINDS)[number])) {
      alert(`Unknown action. agent-browser find supports: ${findKinds.join(', ')}`);
      return;
    }
    const selector: SelectorStrategy = { role: '', name: '', find };
    if (action === 'fill') {
      const v = askText('Fill with?');
      if (v != null) add('fill', { selector, value: v });
    } else {
      add(action, { selector });
    }
  }

  function addPress() {
    // Sent to whatever has focus after the previous step. Key names are
    // agent-browser's (Playwright's): a name, a single character, or a chord.
    const key = askText(
      'Press which key? (agent-browser press <key>)\n\n' +
        'Common keys:\n' +
        '  Enter      submit a form / activate the focused button or link\n' +
        '  Tab        move focus to the next field   (Shift+Tab: previous)\n' +
        '  Space      toggle the focused checkbox / radio / button\n' +
        '  Escape     close a dialog, dropdown or tooltip\n' +
        '  ArrowDown  ArrowUp  ArrowLeft  ArrowRight   move in a list or select\n' +
        '  Home  End  PageDown  PageUp   scroll or jump\n' +
        '  Backspace  Delete\n' +
        '  Chords with +:  Control+a   Control+Enter   Shift+Tab   Alt+ArrowLeft\n' +
        '  A single character types it:  a   1   /',
      'Enter',
    );
    if (key == null || !key.trim()) return;
    add('press', { key: key.trim() });
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
      {findKinds.length > 0 && (
        <button
          onClick={addByFind}
          disabled={disabled}
          title={title('Add a step that targets an element with agent-browser find (by role, text, label, placeholder, alt, title or data-testid) — resolved in the live page, loose name matching')}
        >
          + find…
        </button>
      )}
      {allowed.has('press') && (
        <button
          onClick={addPress}
          disabled={disabled}
          title={title('Press a key or chord on the focused element (Enter, Tab, Space, Escape, Control+a, …) — agent-browser press')}
        >
          + press key…
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
