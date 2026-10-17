import { useEffect, useRef, useState } from 'react';
import { type DeviceSize, type ScreenshotMeta } from '@eab/shared';
import { api } from './api.js';
import { useFocusTrap } from './useFocusTrap.js';

// The screenshot viewer: one run's screenshots, one at a time, with previous /
// next (buttons and ← →), Escape and a close button. The frame toggles show
// the image inside a box the size of the viewport it was captured in (from
// its ScreenshotMeta) and scroll it, so a long full-page capture reads like
// the page did on that device; the "screen" frame is the same box at the
// device's physical screen size. Both sizes are the device list's.

export interface ViewerItem {
  runId: number;
  name: string;
  meta: ScreenshotMeta;
}

/** No frame, the viewport (page area), or the whole screen with the viewport inside. */
type FrameMode = 'none' | 'viewport' | 'screen';

const FRAME_KEY = 'eab.screenshotViewer.frame';
const FOLD_KEY = 'eab.screenshotViewer.fold';
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
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef);
  const [frame, setFrame] = useState<FrameMode>(() => {
    try {
      const v = localStorage.getItem(FRAME_KEY);
      return v === 'screen' ? 'screen' : v === 'none' || v === '0' ? 'none' : 'viewport';
    } catch { return 'viewport'; }
  });
  useEffect(() => {
    try { localStorage.setItem(FRAME_KEY, frame); } catch { /* ignore */ }
  }, [frame]);
  // The devices' physical screens, by name: not in the capture meta, looked
  // up in the device list (the admin Devices page's values).
  const [screens, setScreens] = useState<Map<string, DeviceSize>>(() => new Map());
  useEffect(() => {
    api.getDevices()
      .then((r) => setScreens(new Map(r.devices.filter((d) => !d.screenFromViewport).map((d) => [d.name, d.screen] as const))))
      .catch(() => { /* no screen frame then */ });
  }, []);
  // Playwright keeps an iPhone's screen in portrait even for its landscape
  // entries (iOS reports window.screen that way; Android rotates it), so the
  // screen is turned to the viewport's orientation when the two disagree.
  const screen = (() => {
    const s = item?.meta.device ? screens.get(item.meta.device) : undefined;
    if (!s || !item) return null;
    const vp = item.meta.viewport;
    const turn = (vp.width > vp.height) !== (s.width > s.height) && s.width !== s.height;
    return turn ? { width: s.height, height: s.width } : s;
  })();
  // The screen frame needs a known screen; fall back to the viewport frame.
  const frameMode: FrameMode = frame === 'screen' && !screen ? 'viewport' : frame;
  const cycleFrame = () => setFrame((v) => (v === 'none' ? 'viewport' : v === 'viewport' && screen ? 'screen' : 'none'));
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
  // The fold: a line across a full-page capture where the first paint ended
  // — the viewport height in image pixels (CSS height × capture scale), as
  // a fraction of the image height so it scales with however the image is
  // shown. Drawn by the viewer, never in the file.
  const [fold, setFold] = useState<boolean>(() => {
    try { return localStorage.getItem(FOLD_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(FOLD_KEY, fold ? '1' : '0'); } catch { /* ignore */ }
  }, [fold]);
  const foldPct = (() => {
    if (!item || !item.meta.fullPage) return null;
    const imgH = natural?.h ?? item.meta.height;
    if (!imgH) return null;
    const px = item.meta.viewport.height * item.meta.viewport.scale;
    return px < imgH ? (px / imgH) * 100 : null; // no line when the page fits the viewport
  })();

  // The frame is exactly what was visible on the device, in screen pixels,
  // never fitted to the window: a 390×844 phone is a 390×844 box, a
  // 360×800 one is smaller, and the page reads at the size it had there.
  // A zoomed capture is laid out in a SMALLER CSS viewport (1440×900 at
  // 400% = 360×225 CSS px) but drawn 4× larger into the same window, so its
  // frame is viewport × zoom — the 1440×900 window — with the image at its
  // native pixels. When the frame is taller than the window the stage
  // scrolls; the frame itself scrolls only as far as the page did.
  // The display scale shrinks that whole area on screen (see SCALES).
  // The screen frame is the same box at the device's screen size instead
  // (taller: the browser's bars are part of it).
  const frameSize = (() => {
    if (!item) return null;
    const z = item.meta.zoom ? item.meta.zoom / 100 : 1;
    const s = scale / 100;
    const real = frameMode === 'screen' && screen
      ? { width: screen.width, height: screen.height }
      : { width: Math.round(item.meta.viewport.width * z), height: Math.round(item.meta.viewport.height * z) };
    return { width: Math.round(real.width * s), height: Math.round(real.height * s), realWidth: real.width, realHeight: real.height };
  })();

  const prev = () => onIndex(index > 0 ? index - 1 : items.length - 1);
  const next = () => onIndex(index < items.length - 1 ? index + 1 : 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'f' || e.key === 'F') cycleFrame();
      else if (e.key === 'l' || e.key === 'L') setFold((v) => !v);
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
  // The image with the fold line laid over it; the wrapper is exactly the
  // image's box, so a percentage offset lands on the same pixel row in the
  // full view and inside the frame.
  const picture = (
    <div className="ssv-picture">
      <img src={src} alt={item.name} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      {fold && foldPct != null && (
        <div className="ssv-fold" style={{ top: `${foldPct}%` }} aria-hidden>
          <span>fold · {vp.height} CSS px</span>
        </div>
      )}
    </div>
  );

  return (
    <div className="ssv-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ssv" role="dialog" aria-modal="true" aria-label={item.name} ref={dialogRef}>
        <header className="ssv-head">
          <strong className="ssv-name" title={item.name}>{item.name}</strong>
          <span className="muted ssv-meta">
            {where}
            {screen && <span title="The device's physical screen, from the device list"> · screen {screen.width}×{screen.height}</span>}
            <span title="The area the page was laid out in (CSS px)"> · viewport {vp.width}×{vp.height}</span>
            {meta.zoom ? ` · zoom ${meta.zoom}%` : ''}
            {meta.inferred && <span title="This run predates capture metadata; device and viewport are a guess from the filename"> · (assumed)</span>}
          </span>
          <span className="ssv-actions">
            <button
              type="button"
              className={`chip${frameMode === 'viewport' ? ' chip-on' : ''}`}
              aria-pressed={frameMode === 'viewport'}
              onClick={() => setFrame((v) => (v === 'viewport' ? 'none' : 'viewport'))}
              title={`Show the image inside a ${vp.width}×${vp.height} frame — the viewport, as in the device list — that scrolls like the page did on the ${where} (F cycles)`}
            >
              viewport frame
            </button>
            {screen && (
              <button
                type="button"
                className={`chip${frameMode === 'screen' ? ' chip-on' : ''}`}
                aria-pressed={frameMode === 'screen'}
                onClick={() => setFrame((v) => (v === 'screen' ? 'none' : 'screen'))}
                title={`Show the image inside a ${screen.width}×${screen.height} frame — the ${where}'s screen, as in the device list (F cycles)`}
              >
                screen frame
              </button>
            )}
            {foldPct != null && (
              <button
                type="button"
                className={`chip${fold ? ' chip-on' : ''}`}
                aria-pressed={fold}
                onClick={() => setFold((v) => !v)}
                title={`Draw a line where the first paint ended: ${vp.height} CSS px down, the viewport height (L)`}
              >
                fold line
              </button>
            )}
            {frameMode !== 'none' && (
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
          <div className={`ssv-stage${frameMode !== 'none' ? ' ssv-stage-frame' : ''}`}>
            {frameMode === 'none' ? (
              <div className="ssv-full">{picture}</div>
            ) : (
              // The frame is the device's viewport or screen; the image fills
              // its width and the rest scrolls, like the page did.
              <div
                className="ssv-frame"
                style={frameSize ? { width: frameSize.width, height: frameSize.height } : undefined}
                title={`${frameSize?.realWidth}×${frameSize?.realHeight} px — the ${where}'s ${frameMode}${meta.zoom ? ` at ${meta.zoom}% zoom (${vp.width}×${vp.height} CSS px)` : ''}${scale !== 100 ? `, shown at ${scale}%` : ''}`}
              >
                {picture}
              </div>
            )}
          </div>
          <button type="button" className="ssv-nav" onClick={next} disabled={items.length < 2} title="Next (→)" aria-label="Next">›</button>
        </div>

        <footer className="ssv-foot muted">
          {index + 1} of {items.length} · ← → to move · F frame (viewport / screen / off) · L fold line · 1 / 2 / 3 = 100 / 75 / 50 % · Esc closes
        </footer>
      </div>
    </div>
  );
}
