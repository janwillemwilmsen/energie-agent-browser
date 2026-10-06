import type { ReactNode } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { FindBy, FindLocator, SelectorStrategy } from '../api.js';
import type { StepStore } from './store.js';
import type { BuiltStep, PickDragData } from './StepDnd.js';
import { shortUrl } from './summarize.js';

// The "+ …" buttons that create Steps. Which buttons appear follows from the
// kinds the caller allows and the capabilities it provides; the input dialogs
// are the browser's prompt() for now, funnelled through askText. A click
// appends the Step; dragging a button into the StepList inserts it at the
// drop position (the shared StepEditorDnd context handles the drop).

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

// One "+ …" button. Click adds the step at the end; dragging it into the step
// list inserts it at the drop position (same mechanics as the snapshot pick
// buttons — see StepDnd). `build` runs the kind's dialog, if any, at click or
// drop time and returns null when the user cancels.
function AddButton({
  id, kind, label, build, onAdd, disabled, title, children,
}: {
  id: string;
  kind: string;
  label: string;
  build: () => BuiltStep | null;
  onAdd: (step: BuiltStep) => void;
  disabled: boolean;
  title?: string;
  children: ReactNode;
}) {
  const data: PickDragData = { type: 'pick', kind, label, build };
  const { listeners, setNodeRef, isDragging } = useDraggable({ id: `add:${id}`, data, disabled });
  return (
    <button
      ref={setNodeRef}
      // Pointer only: Enter/Space must stay a plain click, not a keyboard drag.
      onPointerDown={listeners?.onPointerDown as React.PointerEventHandler<HTMLButtonElement> | undefined}
      className={isDragging ? 'dragging' : undefined}
      disabled={disabled}
      title={`${title ? `${title} — ` : ''}click to add at the end, or drag into the step list`}
      onClick={() => { const step = build(); if (step) onAdd(step); }}
    >
      {children}
    </button>
  );
}

export function AddStepControls(props: AddStepControlsProps) {
  const { store, kinds, defaultUrl, authProfiles, disabledReason, onError, children } = props;
  const selectorWait = props.selectorWait ?? true;
  const allowed = new Set(kinds);
  const disabled = store.busy || !!disabledReason;
  const title = (t?: string) => disabledReason ?? t;
  // A click appends; a drop inserts (StepDnd calls build() itself).
  const onAdd = (step: BuiltStep) => void store.add(step.kind, step.payload);
  const step = (kind: string, payload: Record<string, unknown>): BuiltStep => ({ kind, payload });

  const selectorKinds = SELECTOR_KINDS.filter((k) => allowed.has(k) && (k !== 'wait' || selectorWait));
  const findKinds = FIND_KINDS.filter((k) => allowed.has(k) && (k !== 'wait' || selectorWait));

  // Each build* runs its dialog and returns the step, or null when cancelled.
  function buildBySelector(): BuiltStep | null {
    // Precise targeting when several elements share a role+name: any
    // agent-browser locator, handed to the CLI verbatim.
    const locator = askText(
      'Locator (agent-browser syntax):\n' +
        '  #id   .class   div > button   [data-testid="x"]   text=Submit   xpath=//button[@type="submit"]',
    );
    if (locator == null || !locator.trim()) return null;
    if (locator.trim().startsWith('@')) {
      alert(
        '"@eN" is a snapshot ref, not a selector: agent-browser renumbers elements on every snapshot/navigation, so it cannot be replayed later.\n' +
          'Use the click/type buttons on the snapshot row instead (they re-find the element by role + name each run), or enter a stable locator (#id, [data-testid=…], CSS, text=, xpath=).',
      );
      return null;
    }
    const action = (askText(`Action? ${selectorKinds.join(' / ')}`, selectorKinds[0]) ?? '')
      .trim()
      .toLowerCase();
    if (!selectorKinds.includes(action as (typeof SELECTOR_KINDS)[number])) {
      alert('Unknown action');
      return null;
    }
    const selector: SelectorStrategy = { role: '', name: '', locator: locator.trim() };
    if (action === 'fill') {
      const value = askText('Fill with?');
      return value != null ? step('fill', { selector, value }) : null;
    }
    if (action === 'type') {
      const text = askText('Type what?');
      return text != null ? step('type', { selector, text }) : null;
    }
    if (action === 'select') {
      const value = askText('Select which option? (option label)');
      return value != null && value.trim() ? step('select', { selector, value: value.trim() }) : null;
    }
    return step(action, { selector });
  }

  function buildByFind(): BuiltStep | null {
    // agent-browser's semantic locators (getByRole / getByLabel / …): the
    // browser tool resolves them in the live page, so they see through shadow
    // DOM and match names loosely — handy when the a11y-tree name carries
    // invisible glyphs, or a label isn't associated with its input.
    const byRaw = (askText(`Find by? ${FIND_BY.join(' / ')}`, 'role') ?? '').trim().toLowerCase();
    if (!byRaw) return null;
    if (!FIND_BY.includes(byRaw as FindBy)) {
      alert(`Unknown find strategy "${byRaw}". Use one of: ${FIND_BY.join(', ')}`);
      return null;
    }
    const by = byRaw as FindBy;
    const value = askText(
      by === 'role' ? 'Role? (button, checkbox, textbox, link, heading, …)'
      : by === 'testid' ? 'data-testid value?'
      : `${by[0]!.toUpperCase()}${by.slice(1)} text?`,
    );
    if (value == null || !value.trim()) return null;
    const find: FindLocator = { by, value: value.trim() };
    if (by === 'role') {
      const name = askText('Accessible name? (case-insensitive substring; leave blank for any)');
      if (name == null) return null;
      if (name.trim()) find.name = name.trim();
    }
    if ((askText('Exact, case-sensitive match? (y/N)', 'n') ?? 'n').trim().toLowerCase().startsWith('y')) {
      find.exact = true;
    }
    const action = (askText(`Action? ${findKinds.join(' / ')}`, findKinds[0]) ?? '').trim().toLowerCase();
    if (!findKinds.includes(action as (typeof FIND_KINDS)[number])) {
      alert(`Unknown action. agent-browser find supports: ${findKinds.join(', ')}`);
      return null;
    }
    const selector: SelectorStrategy = { role: '', name: '', find };
    if (action === 'fill') {
      const v = askText('Fill with?');
      return v != null ? step('fill', { selector, value: v }) : null;
    }
    return step(action, { selector });
  }

  function buildPress(): BuiltStep | null {
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
    if (key == null || !key.trim()) return null;
    return step('press', { key: key.trim() });
  }

  function buildNavigate(): BuiltStep | null {
    if (defaultUrl) return step('navigate', { url: defaultUrl });
    const url = askText('Navigate to URL?');
    return url ? step('navigate', { url }) : null;
  }

  function buildWait(): BuiltStep | null {
    const raw = askText('Wait how many milliseconds?', '1000');
    if (raw == null) return null;
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) {
      alert('Must be a positive integer');
      return null;
    }
    return step('wait', { ms: Math.floor(ms) });
  }

  function buildAuthLogin(): BuiltStep | null {
    if (!authProfiles) return null;
    if (authProfiles.names.length === 0) {
      authProfiles.onManage();
      return null;
    }
    const choice = askText(
      'Which auth profile? Available: ' +
        authProfiles.names.join(', ') +
        '\n\n(type one of the names above, or leave blank to manage profiles)',
    );
    if (choice == null) return null;
    const trimmed = choice.trim();
    if (!trimmed) {
      authProfiles.onManage();
      return null;
    }
    if (!authProfiles.names.includes(trimmed)) {
      onError?.(`No auth profile named "${trimmed}". Manage profiles below.`);
      authProfiles.onManage();
      return null;
    }
    return step('auth-login', { name: trimmed });
  }

  // Default artifact label; evaluated at click/drop time so it reflects the
  // list length at that moment.
  const artifactLabel = () => `step-${store.steps.length}`;

  // Shorthand for a button whose step needs no dialog.
  const fixed = (id: string, kind: string, label: string, payload: () => Record<string, unknown>, text: ReactNode, hint?: string) => (
    <AddButton id={id} kind={kind} label={label} build={() => step(kind, payload())} onAdd={onAdd} disabled={disabled} title={title(hint)}>
      {text}
    </AddButton>
  );

  return (
    <div className="actions step-editor-add">
      {allowed.has('navigate') && (
        <AddButton id="navigate" kind="navigate" label={defaultUrl ?? 'navigate'} build={buildNavigate} onAdd={onAdd} disabled={disabled} title={title(defaultUrl ? `Navigate to ${defaultUrl}` : undefined)}>
          + navigate{defaultUrl ? ` (${shortUrl(defaultUrl)})` : ''}
        </AddButton>
      )}
      {selectorKinds.length > 0 && (
        <AddButton
          id="by-selector" kind="click" label="by selector…" build={buildBySelector} onAdd={onAdd} disabled={disabled}
          title={title('Add a step that targets an element by a precise locator (#id, CSS, [data-testid], text=, xpath=) instead of role+name')}
        >
          + by selector…
        </AddButton>
      )}
      {findKinds.length > 0 && (
        <AddButton
          id="find" kind="click" label="find…" build={buildByFind} onAdd={onAdd} disabled={disabled}
          title={title('Add a step that targets an element with agent-browser find (by role, text, label, placeholder, alt, title or data-testid) — resolved in the live page, loose name matching')}
        >
          + find…
        </AddButton>
      )}
      {allowed.has('press') && (
        <AddButton
          id="press" kind="press" label="press key…" build={buildPress} onAdd={onAdd} disabled={disabled}
          title={title('Press a key or chord on the focused element (Enter, Tab, Space, Escape, Control+a, …) — agent-browser press')}
        >
          + press key…
        </AddButton>
      )}
      {allowed.has('screenshot') && (
        <>
          {fixed('shot-full', 'screenshot', 'screenshot (full page)', () => ({ label: artifactLabel(), fullPage: true }), '+ screenshot (full page)')}
          {fixed('shot-viewport', 'screenshot', 'screenshot (viewport)', () => ({ label: artifactLabel(), fullPage: false }), '+ screenshot (viewport)')}
          {fixed('shot-mobile', 'screenshot', 'screenshot (mobile)', () => ({ label: artifactLabel(), fullPage: true, viewport: 'mobile' }), '+ screenshot (mobile)',
            'Switch to the mobile device, capture a full-page screenshot, then restore the viewport')}
          {/* An annotated screenshot is still available: edit a screenshot step and tick `annotate`. */}
        </>
      )}
      {allowed.has('save_text') && fixed('save-text', 'save_text', 'save text', () => ({ label: artifactLabel() }), '+ save text',
        "Save the page's readable text (agent-browser read) as a Markdown file beside the run's screenshots")}
      {allowed.has('scroll') && (
        <>
          {fixed('scroll-bottom', 'scroll', 'scroll to bottom', () => ({ toBottom: true }), '+ scroll to bottom',
            'Scroll the page to the bottom in strides so lazy-loaded images fire')}
          {fixed('scroll-top', 'scroll', 'scroll to top', () => ({ toTop: true }), '+ scroll to top',
            'Jump back to the top of the page (useful before targeting a header element)')}
        </>
      )}
      {allowed.has('wait') && (
        <AddButton id="wait" kind="wait" label="wait (ms)" build={buildWait} onAdd={onAdd} disabled={disabled} title={title()}>
          + wait (ms)
        </AddButton>
      )}
      {allowed.has('pause') && fixed('pause', 'pause', 'pause', () => ({}), '+ ⏸ pause',
        'Stop the run here with the browser as it is, until you click Resume on the run (or 10 min pass). Scheduled runs skip it.')}
      {allowed.has('record_start') && fixed('record-start', 'record_start', 'start recording', () => ({}), '+ ⏺ start recording',
        'Start a video recording from this point in the scenario (saved to the Recordings page)')}
      {allowed.has('record_stop') && fixed('record-stop', 'record_stop', 'stop recording', () => ({}), '+ ⏹ stop recording',
        'Stop the video recording and save it')}
      {allowed.has('close') && fixed('close', 'close', 'close session', () => ({}), '+ ✕ close session',
        'Close the browser session (agent-browser close) — useful as a final step to end the scenario cleanly')}
      {allowed.has('auth-login') && authProfiles && (
        <AddButton id="auth-login" kind="auth-login" label="auth login" build={buildAuthLogin} onAdd={onAdd} disabled={disabled}
          title={title('Single-step encrypted login using a saved auth profile')}
        >
          + auth login
        </AddButton>
      )}
      {children}
    </div>
  );
}
