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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setStatus('idle');
      return;
    }
    setStatus('connecting');
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
      <img ref={imgRef} alt="live preview" className="preview-frame" />
    </div>
  );
}
