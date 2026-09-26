import { useState } from 'react';
import type { EditableStep } from './store.js';

// Modal for the ✎ button on a step row. Screenshot steps get friendly fields —
// label, full page, mobile, annotate, plus output format and quality (smaller
// files with jpeg/webp) — while every other kind exposes the payload JSON
// directly. Unknown payload keys are preserved on save. The kind itself is not
// editable here (the admin raw editor does that).
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

  // Screenshot-friendly fields.
  const [label, setLabel] = useState(String(initial.label ?? ''));
  const [fullPage, setFullPage] = useState(initial.fullPage !== false);
  const [mobile, setMobile] = useState(initial.viewport === 'mobile');
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
      if (mobile) next.viewport = 'mobile'; else delete next.viewport;
      if (annotate) next.annotate = true; else delete next.annotate;
      if (format === 'png') {
        delete next.format;
        delete next.quality;
      } else {
        next.format = format;
        next.quality = Math.min(100, Math.max(1, Math.round(quality)));
      }
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
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="screenshot" />
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
            <label style={row}>
              <input type="checkbox" checked={mobile} onChange={(e) => setMobile(e.target.checked)} />
              Mobile viewport (switch device, capture, switch back)
            </label>
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
        ) : (
          <label style={col}>
            <span>Payload JSON</span>
            <textarea
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
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : '💾 Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
