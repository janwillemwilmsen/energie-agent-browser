import { useState } from 'react';
import { api, type A11yTree } from '../api.js';
import { SnapshotPicker, type Pick } from '../SnapshotPicker.js';
import type { StepStore } from './store.js';

// Snapshot the live page and pick nodes to turn into Steps. Which pick buttons
// a node offers follows from the kinds the caller allows.
export interface SnapshotPaneProps {
  store: StepStore;
  kinds: readonly string[];
  /** The browser session to snapshot. */
  session: string;
  /** When given, adds a "Snapshot <url>" button that navigates there first. */
  defaultUrl?: string;
  /** Whether a node may be picked as a `wait` target. Default true. */
  selectorWait?: boolean;
  /**
   * When given, the pane renders its own `<h2>` with this title and the
   * snapshot buttons beside it (the Scenario editor's Preview heading has the
   * same shape). Without it the buttons render as a plain action row and the
   * caller supplies its own heading.
   */
  title?: string;
  onError?: (message: string) => void;
}

export function SnapshotPane(props: SnapshotPaneProps) {
  const { store, kinds, session, defaultUrl, onError } = props;
  const selectorWait = props.selectorWait ?? true;
  const allowed = new Set(kinds);
  const [tree, setTree] = useState<A11yTree | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);
  const add = (kind: string, payload: Record<string, unknown>) => void store.add(kind, payload);

  // A pick → a step payload. Shared by a click on the pick button (append)
  // and a drop into the step list (insert at position); the prompts for the
  // kinds that need text happen here, at click/drop time.
  function buildPayload(pick: Pick): Record<string, unknown> | null {
    const { kind, selector } = pick;
    switch (kind) {
      case 'type': {
        const text = prompt('Type what?');
        return text != null ? { selector, text } : null;
      }
      case 'fill': {
        const value = prompt('Fill with?');
        return value != null ? { selector, value } : null;
      }
      case 'select': {
        // A pick from an option row arrives with the value pre-filled;
        // a pick from the combobox row itself asks for the label.
        const v = pick.value ?? prompt('Select which option? (option label, e.g. "1 persoon")');
        return v != null && v.trim() ? { selector, value: v.trim() } : null;
      }
      default:
        return { selector };
    }
  }

  async function takeSnapshot(opts: { url?: string; interactiveOnly?: boolean } = {}) {
    setSnapshotting(true);
    try {
      const res = await api.snapshot({
        url: opts.url,
        session,
        compact: true,
        interactiveOnly: opts.interactiveOnly ?? false,
      });
      setTree(res.tree);
    } catch (e: any) {
      onError?.(e?.message ?? String(e));
    } finally {
      setSnapshotting(false);
    }
  }

  // Next to a "Snapshot" heading the word is redundant on every button.
  const inHeading = !!props.title;
  const label = (text: string) => (inHeading ? text : `Snapshot ${text}`);
  const buttons = (
    <>
      {defaultUrl && (
        <button
          onClick={() => void takeSnapshot({ url: defaultUrl })}
          disabled={snapshotting}
          title={`Navigate to ${defaultUrl}, then snapshot`}
        >
          {snapshotting ? 'Snapshotting…' : label(defaultUrl)}
        </button>
      )}{' '}
      <button onClick={() => void takeSnapshot()} disabled={snapshotting} title="Snapshot the page the browser is on now">
        {snapshotting && !defaultUrl ? 'Snapshotting…' : label('current page')}
      </button>{' '}
      <button
        onClick={() => void takeSnapshot({ interactiveOnly: true })}
        disabled={snapshotting}
        title="Snapshot current page, interactive elements only (-i)"
      >
        {label('interactive (-i)')}
      </button>
    </>
  );

  return (
    <>
      {props.title ? (
        <h2>
          {props.title} {buttons}
        </h2>
      ) : (
        <div className="actions">{buttons}</div>
      )}
      {tree && (
        <SnapshotPicker
          tree={tree}
          kinds={allowed}
          selectorWait={selectorWait}
          buildPayload={buildPayload}
          onPick={add}
        />
      )}
    </>
  );
}
