import { useEffect, useRef, useState } from 'react';

export function PreviewStream({
  session,
  active,
}: {
  session: string;
  active: boolean;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'error' | 'closed'>(
    'idle',
  );
  const [hasFrame, setHasFrame] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setStatus('idle');
      setHasFrame(false);
      return;
    }
    setStatus('connecting');
    setHasFrame(false);
    setError(null);

    const url =
      (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
      window.location.host +
      `/ws/screencast?session=${encodeURIComponent(session)}`;

    const ws = new WebSocket(url);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'frame' && imgRef.current) {
          imgRef.current.src = `data:image/jpeg;base64,${msg.data}`;
          setHasFrame(true);
          setStatus('live');
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
      </div>
      {error && <pre className="preview-help">{error}</pre>}
      <img
        ref={imgRef}
        alt="live preview"
        className="preview-frame"
        style={{ display: hasFrame ? 'block' : 'none' }}
      />
      {!hasFrame && !error && (
        <div className="preview-frame preview-frame-empty">
          {status === 'connecting' ? 'Connecting to preview…' : 'Preview is off — click start.'}
        </div>
      )}
    </div>
  );
}
