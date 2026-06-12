import { useEffect, useRef, useState } from 'react';
import { ALL_FORMATS, CanvasSink, Input, UrlSource, type InputVideoTrack } from 'mediabunny';

// Canvas-based player built on Mediabunny. agent-browser / Playwright WebM files
// are frequently non-seekable in a plain <video> (the duration/cues aren't in
// the header), so we decode frames with Mediabunny and render them to a canvas,
// which gives reliable play/pause and scrubbing regardless of the container's
// metadata.
//
// Lazy by design: nothing is decoded until the user clicks Load, so a list of
// many recordings doesn't spin up a decoder per item on mount.

type Phase = 'idle' | 'loading' | 'ready' | 'error';

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function MediabunnyPlayer({ src }: { src: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<Input | null>(null);
  const sinkRef = useRef<CanvasSink | null>(null);
  // Monotonic token: bumping it invalidates any in-flight playback loop so
  // pause / seek / unmount stop the previous generator cleanly.
  const tokenRef = useRef(0);
  const curRef = useRef(0);
  const disposedRef = useRef(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    return () => {
      disposedRef.current = true;
      tokenRef.current++;
      try {
        inputRef.current?.dispose();
      } catch {
        /* ignore */
      }
    };
  }, []);

  function draw(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const el = canvasRef.current;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(canvas as CanvasImageSource, 0, 0, el.width, el.height);
  }

  async function load() {
    setPhase('loading');
    setError(null);
    try {
      const input = new Input({ source: new UrlSource(src), formats: ALL_FORMATS });
      inputRef.current = input;
      const track: InputVideoTrack | null = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('No video track found in this file.');
      if (disposedRef.current) return;

      const el = canvasRef.current;
      if (el) {
        el.width = track.displayWidth;
        el.height = track.displayHeight;
      }
      const dur = await input.computeDuration();
      const sink = new CanvasSink(track);
      sinkRef.current = sink;
      if (disposedRef.current) return;

      setDuration(dur);
      // Show the first frame, then let the user press play.
      const first = await sink.getCanvas(0);
      if (first) draw(first.canvas);
      setPhase('ready');
      void play();
    } catch (e: any) {
      if (disposedRef.current) return;
      setError(e?.message ?? String(e));
      setPhase('error');
    }
  }

  async function play() {
    const sink = sinkRef.current;
    if (!sink || playing) return;
    const token = ++tokenRef.current;
    setPlaying(true);

    let start = curRef.current;
    if (start >= duration - 0.05) start = 0; // at the end → replay from the top
    const wallStart = performance.now();
    try {
      for await (const wc of sink.canvases(start)) {
        if (token !== tokenRef.current) return; // superseded
        const targetWall = wallStart + (wc.timestamp - start) * 1000;
        const delay = targetWall - performance.now();
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (token !== tokenRef.current) return;
        draw(wc.canvas);
        curRef.current = wc.timestamp;
        setCurrent(wc.timestamp);
      }
      if (token === tokenRef.current) {
        setPlaying(false);
      }
    } catch (e: any) {
      if (token === tokenRef.current && !disposedRef.current) {
        setError(e?.message ?? String(e));
        setPlaying(false);
      }
    }
  }

  function pause() {
    tokenRef.current++; // stop the running loop
    setPlaying(false);
  }

  async function seek(t: number) {
    const sink = sinkRef.current;
    if (!sink) return;
    const wasPlaying = playing;
    tokenRef.current++; // halt any loop
    setPlaying(false);
    curRef.current = t;
    setCurrent(t);
    const wc = await sink.getCanvas(t);
    if (wc) draw(wc.canvas);
    if (wasPlaying) void play();
  }

  return (
    <div className="mb-player">
      <div className="mb-canvas-wrap">
        <canvas ref={canvasRef} className="mb-canvas" />
        {phase === 'idle' && (
          <button type="button" className="mb-load" onClick={() => void load()}>
            ▶ Load video
          </button>
        )}
        {phase === 'loading' && <div className="mb-overlay">Decoding…</div>}
        {phase === 'error' && <div className="mb-overlay mb-error">⚠ {error}</div>}
      </div>

      {phase === 'ready' && (
        <div className="mb-controls">
          <button type="button" onClick={() => (playing ? pause() : void play())}>
            {playing ? '⏸' : '▶'}
          </button>
          <span className="mb-time">{fmt(current)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.001)}
            step={0.05}
            value={Math.min(current, duration)}
            onChange={(e) => void seek(Number(e.target.value))}
            className="mb-seek"
          />
          <span className="mb-time">{fmt(duration)}</span>
        </div>
      )}
    </div>
  );
}
