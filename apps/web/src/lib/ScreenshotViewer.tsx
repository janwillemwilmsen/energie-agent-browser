import { useEffect, useState } from 'react';
import { type ScreenshotMeta } from '@eab/shared';
import { api } from './api.js';

// The screenshot viewer: one run's screenshots, one at a time, with previous /
// next (buttons and ← →), Escape and a close button. The "device frame"
// toggle shows the image inside a box with the aspect ratio of the viewport
// it was captured in (from its ScreenshotMeta) and scrolls it, so a long
// full-page capture reads like the page did on that device.

export interface ViewerItem {
  runId: number;
  name: string;
  meta: ScreenshotMeta;
}

const FRAME_KEY = 'eab.screenshotViewer.frame';

export function ScreenshotViewer({
  items, index, onIndex, onClose,
}: {
  items: ViewerItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const item = items[index];
  const [frame, setFrame] = useState<boolean>(() => {
    try { return localStorage.getItem(FRAME_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(FRAME_KEY, frame ? '1' : '0'); } catch { /* ignore */ }
  }, [frame]);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => setNatural(null), [item?.runId, item?.name]);

  const prev = () => onIndex(index > 0 ? index - 1 : items.length - 1);
  const next = () => onIndex(index < items.length - 1 ? index + 1 : 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'f' || e.key === 'F') setFrame((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!item) return null;
  const { meta } = item;
  const src = api.runScreenshotUrl(item.runId, item.name);
  const vp = meta.viewport;
  const where = meta.device ?? 'desktop';
  const px = natural ? `${natural.w}×${natural.h} px` : meta.width && meta.height ? `${meta.width}×${meta.height} px` : '';

  return (
    <div className="ssv-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ssv" role="dialog" aria-modal="true" aria-label={item.name}>
        <header className="ssv-head">
          <strong className="ssv-name" title={item.name}>{item.name}</strong>
          <span className="muted ssv-meta">
            {where} · {vp.width}×{vp.height} CSS px @{vp.scale}×{meta.zoom ? ` · zoom ${meta.zoom}%` : ''}
            {meta.fullPage ? ' · full page' : ' · viewport'}{px ? ` · ${px}` : ''}
            {meta.inferred && <span title="This run predates capture metadata; device and viewport are a guess from the filename"> · (assumed)</span>}
          </span>
          <span className="ssv-actions">
            <button
              type="button"
              className={`chip${frame ? ' chip-on' : ''}`}
              aria-pressed={frame}
              onClick={() => setFrame((v) => !v)}
              title={`Show the image inside a ${vp.width}×${vp.height} frame that scrolls like the page did on the ${where} (F)`}
            >
              device frame
            </button>
            <a className="chip" href={src} target="_blank" rel="noreferrer" title="Open the file itself in a new tab">open file</a>
            <button type="button" className="ssv-close" onClick={onClose} title="Close (Escape)" aria-label="Close">×</button>
          </span>
        </header>

        <div className="ssv-body">
          <button type="button" className="ssv-nav" onClick={prev} disabled={items.length < 2} title="Previous (←)" aria-label="Previous">‹</button>
          <div className="ssv-stage">
            {frame ? (
              // The frame has the capture viewport's aspect ratio and is as
              // wide as the stage allows; the image fills its width and the
              // rest scrolls, like the page did.
              <div className="ssv-frame" style={{ aspectRatio: `${vp.width} / ${vp.height}` }}>
                <img src={src} alt={item.name} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
              </div>
            ) : (
              <div className="ssv-full">
                <img src={src} alt={item.name} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
              </div>
            )}
          </div>
          <button type="button" className="ssv-nav" onClick={next} disabled={items.length < 2} title="Next (→)" aria-label="Next">›</button>
        </div>

        <footer className="ssv-foot muted">
          {index + 1} of {items.length} · ← → to move · F toggles the frame · Esc closes
        </footer>
      </div>
    </div>
  );
}
