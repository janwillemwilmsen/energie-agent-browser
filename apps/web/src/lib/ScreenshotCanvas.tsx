import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseScreenshotMetas, screenshotMetaFor, slotDisplayLabel, type Run } from '@eab/shared';
import { api } from './api.js';
import { useFocusTrap } from './useFocusTrap.js';

// The screenshot canvas: one run's screenshots side by side, at their real
// pixel size, on a full-screen surface that pans (drag) and zooms (wheel or
// pinch, around the cursor). A run switcher moves through the scenario's
// completed runs, newest first like the timeline, so a flow can be read run
// by run without leaving the canvas.

const MIN_Z = 0.02;
const MAX_Z = 8;
const PAD = 32; // screen px kept free around a fitted layout
const WHEEL_KEY = 'eab.screenshotCanvas.wheel';
const ARROW_STEP = 80; // screen px an arrow key moves the view

interface View { x: number; y: number; z: number }

const clampZ = (z: number) => Math.min(MAX_Z, Math.max(MIN_Z, z));

export function ScreenshotCanvas({
  scenarioId, scenarioName, initialRunId, onClose,
}: {
  scenarioId: number;
  scenarioName: string;
  initialRunId: number;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef);

  // The scenario's completed runs, newest first; the switcher's options.
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState(initialRunId);
  useEffect(() => {
    api.listScenarioRuns(scenarioId)
      .then((all) => setRuns(
        all
          .filter((r) => r.status === 'success' || r.status === 'failed')
          .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id),
      ))
      .catch((e) => setError(e?.message ?? String(e)));
  }, [scenarioId]);
  const index = runs ? runs.findIndex((r) => r.id === runId) : -1;
  const run = index >= 0 ? runs![index]! : null;
  useEffect(() => {
    // The opening run is not among the completed ones (still running, say): show the newest.
    if (runs && index < 0 && runs[0]) setRunId(runs[0].id);
  }, [runs, index]);

  const shots = useMemo(() => {
    if (!run) return [] as string[];
    try { return JSON.parse(run.screenshot_paths_json) as string[]; } catch { return []; }
  }, [run]);
  const metas = useMemo(() => parseScreenshotMetas(run?.screenshot_meta_json), [run]);

  // The view: the layout's origin in stage px and its scale.
  const [view, setView] = useState<View>({ x: PAD, y: PAD + 24, z: 1 });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Once the user has zoomed or panned a run the auto-fit (which re-runs as
  // images load and change the layout's size) stops touching the view.
  const touched = useRef(false);

  const fit = useCallback((mode: 'width' | 'all') => {
    const stage = stageRef.current;
    const content = contentRef.current;
    if (!stage || !content) return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const cw = content.offsetWidth; // untransformed size
    const ch = content.offsetHeight;
    if (!cw || !ch || !sw || !sh) return;
    const zw = (sw - 2 * PAD) / cw;
    const z = clampZ(Math.min(mode === 'all' ? Math.min(zw, (sh - 2 * PAD - 24) / ch) : zw, 1));
    setView({ z, x: Math.max(PAD, (sw - cw * z) / 2), y: PAD + 24 });
  }, []);

  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    touched.current = true;
    setView((v) => {
      const z = clampZ(v.z * factor);
      const k = z / v.z;
      return { z, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);
  const zoomCenter = (factor: number) => {
    const s = stageRef.current;
    if (s) zoomAt(s.clientWidth / 2, s.clientHeight / 2, factor);
  };
  const setZoom = (z: number) => {
    const s = stageRef.current;
    if (s) zoomAt(s.clientWidth / 2, s.clientHeight / 2, z / view.z);
  };

  // A new run: fit it to the width once its images have a size, until the
  // user takes over. The observer fires as images load and the layout grows.
  useEffect(() => {
    touched.current = false;
    const content = contentRef.current;
    if (!content) return;
    fit('width');
    const ro = new ResizeObserver(() => { if (!touched.current) fit('width'); });
    ro.observe(content);
    return () => ro.disconnect();
  }, [run?.id, fit]);

  // What a plain scroll does: pan (a two-finger swipe on a trackpad moves the
  // canvas, in any direction) or zoom (a mouse wheel). A pinch arrives as a
  // ctrl-wheel and zooms in either mode, as does ctrl/⌘ + wheel.
  const [wheelMode, setWheelMode] = useState<'pan' | 'zoom'>(() => {
    try { return localStorage.getItem(WHEEL_KEY) === 'zoom' ? 'zoom' : 'pan'; } catch { return 'pan'; }
  });
  useEffect(() => {
    try { localStorage.setItem(WHEEL_KEY, wheelMode); } catch { /* ignore */ }
  }, [wheelMode]);
  const wheelModeRef = useRef(wheelMode);
  wheelModeRef.current = wheelMode;

  // A native listener, because React's is passive and the page must not
  // scroll behind the canvas.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Line/page deltas (some mice) to pixels.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey || wheelModeRef.current === 'zoom') {
        const rect = stage.getBoundingClientRect();
        const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
      } else {
        touched.current = true;
        // Shift turns a vertical mouse wheel into a horizontal pan.
        const [px, py] = e.shiftKey && dx === 0 ? [dy, 0] : [dx, dy];
        setView((v) => ({ ...v, x: v.x - px, y: v.y - py }));
      }
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Drag to pan.
  const drag = useRef<{ id: number; x: number; y: number; vx: number; vy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    touched.current = true;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) { drag.current = null; setDragging(false); }
  };

  const goRun = useCallback((delta: number) => {
    if (!runs || index < 0) return;
    const next = runs[index + delta];
    if (next) setRunId(next.id);
  }, [runs, index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLSelectElement) return;
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      // Space walks the run list (newest first, as on the timeline): Space =
      // next (older), Alt+Space = previous (newer).
      else if (e.key === ' ') { e.preventDefault(); goRun(e.altKey ? -1 : 1); }
      // Arrows move the view the way a scroll would: → shows what is to the
      // right. Shift makes the step five times larger.
      else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? ARROW_STEP * 5 : ARROW_STEP;
        const dx = e.key === 'ArrowRight' ? -step : e.key === 'ArrowLeft' ? step : 0;
        const dy = e.key === 'ArrowDown' ? -step : e.key === 'ArrowUp' ? step : 0;
        touched.current = true;
        setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      }
      else if (e.key === '+' || e.key === '=') zoomCenter(1.25);
      else if (e.key === '-' || e.key === '_') zoomCenter(0.8);
      else if (e.key === '0') { touched.current = false; fit('width'); }
      else if (e.key === '9') { touched.current = true; fit('all'); }
      else if (e.key === '1') setZoom(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const pct = Math.round(view.z * 100);

  return (
    <div className="ssc" role="dialog" aria-modal="true" aria-label={`${scenarioName} canvas`} ref={dialogRef}>
      <header className="ssc-head">
        <strong className="ssc-title" title={scenarioName}>{scenarioName}</strong>
        <span className="ssc-runs">
          <button type="button" className="chip" onClick={() => goRun(-1)} disabled={!runs || index <= 0} title="Previous run — newer (Alt+Space)">‹</button>
          <select
            value={run?.id ?? ''}
            onChange={(e) => setRunId(Number(e.target.value))}
            disabled={!runs || runs.length === 0}
            title="Which run to show"
          >
            {!runs && <option value="">Loading runs…</option>}
            {runs && runs.length === 0 && <option value="">No completed runs</option>}
            {runs?.map((r, i) => (
              <option key={r.id} value={r.id}>
                {formatDate(r.started_at)} · #{r.id} · {r.status}{i === 0 ? ' · latest' : ''}
              </option>
            ))}
          </select>
          <button type="button" className="chip" onClick={() => goRun(1)} disabled={!runs || index < 0 || index >= runs.length - 1} title="Next run — older (Space)">›</button>
          {run && <span className="muted">{shots.length} screenshot{shots.length === 1 ? '' : 's'}</span>}
        </span>
        <span className="ssc-zoom" role="group" aria-label="Zoom">
          <button type="button" className="chip" onClick={() => zoomCenter(0.8)} title="Zoom out (−)">−</button>
          <span className="ssc-zoom-pct" title="Zoom">{pct}%</span>
          <button type="button" className="chip" onClick={() => zoomCenter(1.25)} title="Zoom in (+)">+</button>
          <button type="button" className="chip" onClick={() => { touched.current = false; fit('width'); }} title="Fit all screenshots across the width (0)">fit width</button>
          <button type="button" className="chip" onClick={() => { touched.current = true; fit('all'); }} title="Fit everything in view (9)">fit all</button>
          <button type="button" className={`chip${pct === 100 ? ' chip-on' : ''}`} onClick={() => setZoom(1)} title="Real pixel size (1)">100%</button>
          <button
            type="button"
            className="chip ssc-wheel"
            onClick={() => setWheelMode((m) => (m === 'pan' ? 'zoom' : 'pan'))}
            title={wheelMode === 'pan'
              ? 'Scrolling (a two-finger swipe) moves the canvas; pinch or Ctrl/⌘ + scroll zooms. Click to make scrolling zoom instead.'
              : 'Scrolling (a mouse wheel) zooms; Shift + scroll moves sideways. Click to make scrolling pan instead.'}
          >
            scroll: {wheelMode === 'pan' ? 'pans' : 'zooms'}
          </button>
        </span>
        <button type="button" className="ssv-close" onClick={onClose} title="Close (Escape)" aria-label="Close">×</button>
      </header>

      <div
        className={`ssc-stage${dragging ? ' ssc-dragging' : ''}`}
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {error && <p className="error ssc-note">{error}</p>}
        {run && shots.length === 0 && <p className="muted ssc-note">This run produced no screenshots.</p>}
        <div
          className="ssc-content"
          ref={contentRef}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
        >
          {run && shots.map((name) => {
            const m = screenshotMetaFor(name, metas);
            return (
              <figure className="ssc-shot" key={`${run.id}/${name}`}>
                {/* The caption is counter-scaled so it stays legible at any
                    zoom, and clipped to the image's on-screen width (layout
                    width × z, which the counter-scale turns back into screen
                    px) so neighbours never overlap. */}
                <figcaption
                  style={{ transform: `scale(${1 / view.z})`, maxWidth: Math.max(8, ((m.width ?? m.viewport.width) + 40) * view.z) }}
                  title={`${slotDisplayLabel(name)} — ${m.device ?? 'desktop'} · ${m.viewport.width}×${m.viewport.height}`}
                >
                  <b>{slotDisplayLabel(name)}</b>
                  {' '}{m.device ?? 'desktop'} · {m.viewport.width}×{m.viewport.height}
                  {m.width && m.height ? ` · ${m.width}×${m.height} px` : ''}
                </figcaption>
                <img
                  src={api.runScreenshotUrl(run.id, name)}
                  alt={name}
                  width={m.width ?? undefined}
                  height={m.height ?? undefined}
                  draggable={false}
                  decoding="async"
                />
              </figure>
            );
          })}
        </div>
      </div>

      <footer className="ssc-foot muted">
        {wheelMode === 'pan'
          ? 'two-finger swipe or drag to pan · pinch or Ctrl/⌘ + scroll to zoom'
          : 'drag or Shift + wheel to pan · wheel or pinch to zoom'}
        {' '}· arrows move the view (Shift: faster) · Space next run · Alt+Space previous run · 0 fit width · 9 fit all · 1 = 100% · + − zoom · Esc closes
      </footer>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
