import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../useFocusTrap.js';
import { DEFAULT_MOBILE_DEVICE, DEVICE_NAMES, DESKTOP_VIEWPORT, ZOOM_LEVELS, builtinProfile, zoomedViewport, type DeviceProfile } from '@eab/shared';
import { api } from '../api.js';
import type { EditableStep } from './store.js';

// The device dropdown grouped by family word (iPhone / iPad / Pixel / …), in
// the list's own order within a group.
function groupDevices(list: DeviceProfile[]): [string, DeviceProfile[]][] {
  const map = new Map<string, DeviceProfile[]>();
  for (const d of list) {
    const g = /^(iPhone|iPad|Pixel|Galaxy|Nexus|Moto|Nokia|LG|Kindle|Blackberry|Microsoft|Desktop)/i.exec(d.name)?.[1] ?? 'Other';
    (map.get(g) ?? map.set(g, []).get(g)!).push(d);
  }
  return Array.from(map.entries());
}

// Modal for the ✎ button on a step row. Screenshot steps get friendly fields —
// label, full page, mobile, annotate, plus output format and quality (smaller
// files with jpeg/webp) — and record_start gets its pointer checkbox, while
// every other kind exposes the payload JSON directly. Unknown payload keys are
// preserved on save. The kind itself is not editable here (the admin raw
// editor does that).
export function StepEditModal({
  step,
  onSave,
  onClose,
}: {
  step: EditableStep;
  /** Rejects with a message on failure; the modal shows it and stays open. */
  onSave: (payload: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const initial = step.payload;
  const isScreenshot = step.kind === 'screenshot';
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef);
  const isRecordStart = step.kind === 'record_start';

  // record_start: show a pointer in the video; move it like a person.
  const [cursor, setCursor] = useState(initial.cursor === true);
  const [human, setHuman] = useState(initial.human === true);

  // Screenshot-friendly fields.
  const [label, setLabel] = useState(String(initial.label ?? ''));
  const [fullPage, setFullPage] = useState(initial.fullPage !== false);
  const [expandScrollers, setExpandScrollers] = useState(initial.expandScrollers === true);
  const [mobile, setMobile] = useState(initial.viewport === 'mobile');
  // '' = the default mobile device; a name overrides it for this step. Any
  // stored name is kept (even one no longer in the list — it is shown as such).
  const [device, setDevice] = useState<string>(typeof initial.device === 'string' ? initial.device : '');
  // The devices the admin Devices page enables, for the dropdown; the
  // built-ins until it answers.
  const [devices, setDevices] = useState<DeviceProfile[] | null>(null);
  useEffect(() => {
    if (step.kind !== 'screenshot') return;
    api.getDevices()
      .then((r) => { const on = new Set(r.enabled); setDevices(r.devices.filter((d) => on.has(d.name))); })
      .catch(() => setDevices([]));
  }, [step.kind]);
  const deviceOptions = devices && devices.length > 0 ? devices : DEVICE_NAMES.map((n) => builtinProfile(n)!);
  // 0 = no zoom emulation.
  const [zoom, setZoom] = useState<number>(
    (ZOOM_LEVELS as readonly number[]).includes(Number(initial.zoom)) ? Number(initial.zoom) : 0,
  );
  const [annotate, setAnnotate] = useState(initial.annotate === true);
  const [format, setFormat] = useState<string>(
    initial.format === 'jpeg' || initial.format === 'jpg' ? 'jpeg' : initial.format === 'webp' ? 'webp' : 'png',
  );
  const [quality, setQuality] = useState<number>(
    Number.isFinite(Number(initial.quality)) && Number(initial.quality) > 0 ? Number(initial.quality) : 80,
  );

  // Raw JSON editor for all other step kinds.
  const [json, setJson] = useState(() => JSON.stringify(initial, null, 2));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    let payload: Record<string, unknown>;
    if (isScreenshot) {
      const next: Record<string, unknown> = { ...initial, label: label.trim() || 'screenshot', fullPage };
      if (fullPage && expandScrollers) next.expandScrollers = true; else delete next.expandScrollers;
      if (mobile) next.viewport = 'mobile'; else delete next.viewport;
      if (mobile && device) next.device = device; else delete next.device;
      // Zoom is a desktop test (reflow at 720/480/360 px); a phone is already
      // at that width, so a mobile shot saves without one.
      if (zoom && !mobile) next.zoom = zoom; else delete next.zoom;
      if (annotate) next.annotate = true; else delete next.annotate;
      if (format === 'png') {
        delete next.format;
        delete next.quality;
      } else {
        next.format = format;
        next.quality = Math.min(100, Math.max(1, Math.round(quality)));
      }
      payload = next;
    } else if (isRecordStart) {
      const next: Record<string, unknown> = { ...initial };
      if (cursor) next.cursor = true; else delete next.cursor;
      if (human) next.human = true; else delete next.human;
      payload = next;
    } else {
      try {
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('payload must be a JSON object');
        payload = parsed as Record<string, unknown>;
      } catch (e: any) {
        setError(`Invalid JSON: ${e?.message ?? e}`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(payload);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setBusy(false);
    }
  }

  // Keyboard: Escape cancels, Ctrl/⌘+Enter saves — from anywhere in the
  // modal, including the JSON textarea (where plain Enter is a newline).
  // Listened on the window so it works before anything inside has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !busy) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const col: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 };
  const row: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Edit step ${step.kind}`}
        style={{
          width: '100%', maxWidth: 480, maxHeight: '85vh', overflow: 'auto',
          background: 'var(--bg, #1b1b1f)', border: '1px solid var(--border, rgba(127,127,127,0.35))',
          borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>
          Edit step <code>{step.kind}</code>
        </h2>
        {step.invalid && (
          <p className="error" style={{ margin: 0 }}>
            This step does not match the schema: {step.invalid}
          </p>
        )}
        {isScreenshot ? (
          <>
            <label style={col}>
              <span>Label</span>
              <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="screenshot" />
            </label>
            {/* An explicit choice rather than a lone "Full page" checkbox: it
                was not obvious that unchecking it meant "viewport", and the
                viewport capture is the one that works for modals. */}
            <label style={col}>
              <span>Capture area</span>
              <select value={fullPage ? 'full' : 'viewport'} onChange={(e) => setFullPage(e.target.value === 'full')}>
                <option value="full">Full page — the entire scrollable page</option>
                <option value="viewport">Viewport — only what is on screen</option>
              </select>
              <span className="muted" style={{ fontSize: 12 }}>
                {fullPage
                  ? 'Fixed overlays such as modals and dialogs are not drawn in a full-page capture — use Viewport for those.'
                  : 'Captures the visible area, including open modals and dialogs.'}
              </span>
            </label>
            {fullPage && (
              <label style={{ ...row, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={expandScrollers}
                  onChange={(e) => setExpandScrollers(e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <span>
                  Expand inner scroll containers
                  <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                    For pages where only an inner panel scrolls (the full-page shot comes out
                    viewport-sized): temporarily unlocks it so the whole content is captured,
                    then restores the layout.
                  </span>
                </span>
              </label>
            )}
            <label style={row}>
              <input type="checkbox" checked={mobile} onChange={(e) => setMobile(e.target.checked)} />
              Mobile viewport (switch device, capture, switch back)
              {mobile && !device && <span className="muted"> — {DEFAULT_MOBILE_DEVICE}</span>}
            </label>
            {mobile && (
              <label style={{ ...col, marginLeft: 22 }}>
                <span>Device</span>
                <select value={device} onChange={(e) => setDevice(e.target.value)}>
                  <option value="">Default ({DEFAULT_MOBILE_DEVICE})</option>
                  {device && !deviceOptions.some((d) => d.name === device) && (
                    <option value={device}>{device} (not in the device list)</option>
                  )}
                  {groupDevices(deviceOptions).map(([group, list]) => (
                    <optgroup key={group} label={group}>
                      {list.map((d) => (
                        <option key={d.name} value={d.name}>{d.name} — {d.width}×{d.height} @{d.scale}×</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <span className="muted" style={{ fontSize: 12 }}>
                  Viewport, scale and a matching user agent. The list is managed on Admin → Devices; picking one
                  overrides the default for this step only.
                </span>
              </label>
            )}
            {/* Desktop only: zoom emulates reflow at 720/480/360 px, which a
                phone viewport already is; a mobile shot has no zoom. */}
            {!mobile && (
              <label style={col}>
                <span>Browser zoom</span>
                <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
                  <option value={0}>None (100%)</option>
                  {ZOOM_LEVELS.map((z) => {
                    // Preview what the page will see at that zoom.
                    const v = zoomedViewport(DESKTOP_VIEWPORT, z);
                    return <option key={z} value={z}>{z}% — page sees {v.width}×{v.height} CSS px</option>;
                  })}
                </select>
                <span className="muted" style={{ fontSize: 12 }}>
                  Emulates a user with browser/display zoom (accessibility): the layout width shrinks and every
                  breakpoint reacts as it would for them; the image stays the same size. Saved as a separate slot
                  (<code>label-zoom200</code>) so it diffs against other runs&apos; zoomed shots. 200–400% are the WCAG reflow test points.
                </span>
              </label>
            )}
            <label style={row}>
              <input type="checkbox" checked={annotate} onChange={(e) => setAnnotate(e.target.checked)} />
              Annotate interactive elements
            </label>
            <label style={col}>
              <span>File format</span>
              <select value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="png">png — lossless, largest files</option>
                <option value="jpeg">jpeg — small files</option>
                <option value="webp">webp — smallest files</option>
              </select>
            </label>
            {format !== 'png' && (
              <label style={col}>
                <span>Quality: {quality}</span>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                />
                <span className="muted" style={{ fontSize: 12 }}>
                  Lower = smaller files; 70–85 is usually visually indistinguishable.
                </span>
              </label>
            )}
          </>
        ) : isRecordStart ? (
          <>
            <label style={{ ...row, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={cursor} onChange={(e) => setCursor(e.target.checked)} style={{ marginTop: 2 }} />
              <span>
                Show the mouse pointer in the video
                <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                  Draws an arrow that follows the mouse, with a ripple on each click, until the
                  recording stops. Screenshots taken while recording include it.
                </span>
              </span>
            </label>
            <label style={{ ...row, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={human} onChange={(e) => setHuman(e.target.checked)} style={{ marginTop: 2 }} />
              <span>
                Move the mouse like a person between clicks
                <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                  While recording, each click travels along an eased curve from the previous click to
                  the new element (about 0.8 s) instead of jumping. Not for find-based clicks or
                  check / uncheck.
                </span>
              </span>
            </label>
          </>
        ) : (
          <label style={col}>
            <span>Payload JSON</span>
            <textarea
              autoFocus
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={10}
              spellCheck={false}
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 12,
                resize: 'vertical',
              }}
            />
          </label>
        )}
        {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          <span className="muted" style={{ marginRight: 'auto', fontSize: 12 }}>Esc to cancel · Ctrl+Enter to save</span>
          <button onClick={onClose} disabled={busy} title="Escape">Cancel</button>
          <button onClick={() => void save()} disabled={busy} title="Ctrl+Enter (⌘+Enter on a Mac)">
            {busy ? 'Saving…' : '💾 Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
