import { useEffect, useRef, useState } from 'react';

// The frame grab (`agent-browser screenshot`) fails like this while the
// browser has no page to capture — a navigation is committing, or a `close`
// step ended the session. Transient, never a broken preview.
export function isBetweenPages(message: string): boolean {
  return /Not attached to an active page|Target closed|no active page|Session closed|browser (has been |was )?closed/i.test(message);
}

export function PreviewStream({
  session,
  active,
}: {
  session: string;
  active: boolean;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'waiting' | 'error' | 'closed'>(
    'idle',
  );
  const [hasFrame, setHasFrame] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Hover magnifier. The preview is the real viewport-size JPEG scaled down by
  // CSS to fit its column, so small text/controls get hard to read. The loupe
  // shows the spot under the cursor at LOUPE_ZOOM× from the SAME frame (no
  // extra traffic) — enough to read labels and pick the right button.
  const [zoomOn, setZoomOn] = useState(true);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [loupe, setLoupe] = useState<{
    left: number; top: number; bgSize: string; bgPos: string;
  } | null>(null);
  const LOUPE_ZOOM = 2.5;
  const LOUPE_SIZE = 220;

  function onFrameMouseMove(e: React.MouseEvent<HTMLImageElement>) {
    if (!zoomOn) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const nw = el.naturalWidth;
    const nh = el.naturalHeight;
    if (!nw || !nh || !rect.width || !rect.height) return;
    // `object-fit: contain` letterboxes the bitmap inside the element box —
    // work out where the drawn image actually is so the lens tracks pixels,
    // not the box.
    const scale = Math.min(rect.width / nw, rect.height / nh);
    const dw = nw * scale;
    const dh = nh * scale;
    const ox = (rect.width - dw) / 2;
    const oy = (rect.height - dh) / 2;
    const x = e.clientX - rect.left - ox;
    const y = e.clientY - rect.top - oy;
    if (x < 0 || y < 0 || x > dw || y > dh) {
      setLoupe(null);
      return;
    }
    const zw = dw * LOUPE_ZOOM;
    const zh = dh * LOUPE_ZOOM;
    setLoupe({
      left: e.clientX - rect.left - LOUPE_SIZE / 2,
      top: e.clientY - rect.top - LOUPE_SIZE / 2,
      bgSize: `${zw}px ${zh}px`,
      bgPos: `${-(x * LOUPE_ZOOM - LOUPE_SIZE / 2)}px ${-(y * LOUPE_ZOOM - LOUPE_SIZE / 2)}px`,
    });
  }

  useEffect(() => {
    if (!active) {
      setStatus('idle');
      setHasFrame(false);
      setLoupe(null);
      return;
    }
    setStatus('connecting');
    setHasFrame(false);
    setError(null);
    setInfo(null);

    const url =
      (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
      window.location.host +
      `/ws/screencast?session=${encodeURIComponent(session)}`;

    const ws = new WebSocket(url);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'frame' && imgRef.current) {
          const src = `data:image/jpeg;base64,${msg.data}`;
          imgRef.current.src = src;
          setFrameSrc(src);
          setHasFrame(true);
          setInfo(null);
          setError(null);
          setStatus('live');
        } else if (msg.type === 'status') {
          // Server-side progress (e.g. "Starting browser session…") — not an error.
          setInfo(msg.message);
        } else if (msg.type === 'error' && isBetweenPages(msg.message)) {
          // A frame could not be taken because the browser has no page right
          // now: mid-navigation, or after a `close` step. The last frame stays
          // up and the next frame clears this; it is not a failure.
          setInfo('No page to show right now (navigating, or the session was closed).');
          setStatus('waiting');
        } else if (msg.type === 'error') {
          setError(msg.message);
          setStatus('error');
        } else if (msg.type === 'help') {
          setError(msg.message);
          setStatus('error');
        }
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => setStatus('error');
    ws.onclose = () => setStatus('closed');

    return () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }, [active, session]);

  return (
    <div className="preview-stream">
      <div className="preview-status">
        <span className={`status status-${status === 'live' ? 'success' : status === 'error' ? 'failed' : 'running'}`}>
          {status}
        </span>
        <button
          type="button"
          className={`preview-zoom-toggle${zoomOn ? ' on' : ''}`}
          onClick={() => { setZoomOn((v) => !v); setLoupe(null); }}
          title={zoomOn ? 'Magnifier on — hover the preview to zoom in. Click to turn off.' : 'Magnifier off — click to zoom in on hover.'}
          aria-pressed={zoomOn}
        >
          🔍 {zoomOn ? 'zoom on' : 'zoom off'}
        </button>
      </div>
      {error && <pre className="preview-help">{error}</pre>}
      {hasFrame && status === 'waiting' && info && <p className="muted preview-info">{info}</p>}
      <div
        className="preview-frame-wrap"
        style={{ display: hasFrame ? 'block' : 'none' }}
        onMouseLeave={() => setLoupe(null)}
      >
        <img
          ref={imgRef}
          alt="live preview"
          className="preview-frame"
          onMouseMove={onFrameMouseMove}
        />
        {zoomOn && loupe && frameSrc && (
          <div
            className="preview-loupe"
            aria-hidden
            style={{
              left: loupe.left,
              top: loupe.top,
              width: LOUPE_SIZE,
              height: LOUPE_SIZE,
              backgroundImage: `url("${frameSrc}")`,
              backgroundSize: loupe.bgSize,
              backgroundPosition: loupe.bgPos,
            }}
          />
        )}
      </div>
      {!hasFrame && !error && (
        <div className="preview-frame preview-frame-empty">
          {status === 'connecting' || status === 'waiting'
            ? info ?? 'Connecting to preview…'
            : 'Preview is off — click start.'}
        </div>
      )}
    </div>
  );
}
