import { useState } from 'react';
import { api, type A11yTree } from '../api.js';
import { SnapshotPicker } from '../SnapshotPicker.js';
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
  onError?: (message: string) => void;
}

export function SnapshotPane(props: SnapshotPaneProps) {
  const { store, kinds, session, defaultUrl, onError } = props;
  const selectorWait = props.selectorWait ?? true;
  const allowed = new Set(kinds);
  const [tree, setTree] = useState<A11yTree | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);
  const add = (kind: string, payload: Record<string, unknown>) => void store.add(kind, payload);

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

  return (
    <>
      <div className="actions">
        {defaultUrl && (
          <button onClick={() => void takeSnapshot({ url: defaultUrl })} disabled={snapshotting}>
            {snapshotting ? 'Snapshotting…' : `Snapshot ${defaultUrl}`}
          </button>
        )}
        <button onClick={() => void takeSnapshot()} disabled={snapshotting}>
          {snapshotting && !defaultUrl ? 'Snapshotting…' : 'Snapshot current page'}
        </button>
        <button
          onClick={() => void takeSnapshot({ interactiveOnly: true })}
          disabled={snapshotting}
          title="Snapshot current page, interactive elements only (-i)"
        >
          Snapshot interactive (-i)
        </button>
      </div>
      {tree && (
        <SnapshotPicker
          tree={tree}
          onPickClick={allowed.has('click') ? (s) => add('click', { selector: s }) : undefined}
          onPickType={
            allowed.has('type')
              ? (s) => {
                  const text = prompt('Type what?');
                  if (text != null) add('type', { selector: s, text });
                }
              : undefined
          }
          onPickFill={
            allowed.has('fill')
              ? (s) => {
                  const value = prompt('Fill with?');
                  if (value != null) add('fill', { selector: s, value });
                }
              : undefined
          }
          onPickSelect={
            allowed.has('select')
              ? (s, value) => {
                  // A pick from an option row arrives with the value pre-filled;
                  // a pick from the combobox row itself asks for the label.
                  const v = value ?? prompt('Select which option? (option label, e.g. "1 persoon")');
                  if (v != null && v.trim()) add('select', { selector: s, value: v.trim() });
                }
              : undefined
          }
          onPickCheck={allowed.has('check') ? (s) => add('check', { selector: s }) : undefined}
          onPickUncheck={allowed.has('uncheck') ? (s) => add('uncheck', { selector: s }) : undefined}
          onPickWait={allowed.has('wait') && selectorWait ? (s) => add('wait', { selector: s }) : undefined}
          onPickScroll={allowed.has('scroll') ? (s) => add('scroll', { selector: s }) : undefined}
        />
      )}
    </>
  );
}
