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
const SCALE_KEY = 'eab.screenshotViewer.scale';
// Display scales for the frame: the device's visible area shrunk as a whole
// (box and content alike), so a 1440×900 desktop frame fits a laptop screen
// without the stage scrolling. 100 is the device's real size.
const SCALES = [50, 75, 100] as const;

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
  const [scale, setScale] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(SCALE_KEY));
      return (SCALES as readonly number[]).includes(v) ? v : 100;
    } catch { return 100; }
  });
  useEffect(() => {
    try { localStorage.setItem(SCALE_KEY, String(scale)); } catch { /* ignore */ }
  }, [scale]);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => setNatural(null), [item?.runId, item?.name]);

  // The frame is exactly what was visible on the device, in screen pixels,
  // never fitted to the window: a 390×844 phone is a 390×844 box, a
  // 360×800 one is smaller, and the page reads at the size it had there.
  // A zoomed capture is laid out in a SMALLER CSS viewport (1440×900 at
  // 400% = 360×225 CSS px) but drawn 4× larger into the same window, so its
  // frame is viewport × zoom — the 1440×900 window — with the image at its
  // native pixels. When the frame is taller than the window the stage
  // scrolls; the frame itself scrolls only as far as the page did.
  // The display scale shrinks that whole area on screen (see SCALES).
  const frameSize = (() => {
    if (!item) return null;
    const { width: vw, height: vh } = item.meta.viewport;
    const z = item.meta.zoom ? item.meta.zoom / 100 : 1;
    const s = scale / 100;
    return { width: Math.round(vw * z * s), height: Math.round(vh * z * s), realWidth: Math.round(vw * z), realHeight: Math.round(vh * z) };
  })();

  const prev = () => onIndex(index > 0 ? index - 1 : items.length - 1);
  const next = () => onIndex(index < items.length - 1 ? index + 1 : 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'f' || e.key === 'F') setFrame((v) => !v);
      // 1 / 2 / 3 pick the display scale (100 / 75 / 50).
      else if (e.key === '1') setScale(100);
      else if (e.key === '2') setScale(75);
      else if (e.key === '3') setScale(50);
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
            {frame && frameSize && <> · frame {frameSize.realWidth}×{frameSize.realHeight}{scale !== 100 ? ` shown at ${scale}%` : ''}</>}
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
            {frame && (
              <span className="ssv-scale" role="group" aria-label="Frame display scale">
                {SCALES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`chip${scale === s ? ' chip-on' : ''}`}
                    aria-pressed={scale === s}
                    onClick={() => setScale(s)}
                    title={s === 100 ? "The device's real size" : `Shrink the whole frame to ${s}% so it fits the window`}
                  >
                    {s}%
                  </button>
                ))}
              </span>
            )}
            <a className="chip" href={src} target="_blank" rel="noreferrer" title="Open the file itself in a new tab">open file</a>
            <button type="button" className="ssv-close" onClick={onClose} title="Close (Escape)" aria-label="Close">×</button>
          </span>
        </header>

        <div className="ssv-body">
          <button type="button" className="ssv-nav" onClick={prev} disabled={items.length < 2} title="Previous (←)" aria-label="Previous">‹</button>
          <div className={`ssv-stage${frame ? ' ssv-stage-frame' : ''}`}>
            {frame ? (
              // The frame is the device's visible area; the image fills its
              // width and the rest scrolls, like the page did.
              <div
                className="ssv-frame"
                style={frameSize ? { width: frameSize.width, height: frameSize.height } : undefined}
                title={`${frameSize?.realWidth}×${frameSize?.realHeight} px — the ${where}'s visible area${meta.zoom ? ` at ${meta.zoom}% zoom (${vp.width}×${vp.height} CSS px)` : ''}${scale !== 100 ? `, shown at ${scale}%` : ''}`}
              >
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
          {index + 1} of {items.length} · ← → to move · F toggles the frame · 1 / 2 / 3 = 100 / 75 / 50 % · Esc closes
        </footer>
      </div>
    </div>
  );
}
