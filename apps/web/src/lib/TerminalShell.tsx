import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export interface TerminalShellHandle {
  /** Send a line of text to the pty (auto-appends CR). */
  send: (line: string) => void;
}

export const TerminalShell = forwardRef<TerminalShellHandle, { height?: number | string }>(
  function TerminalShell({ height = 'calc(100vh - 200px)' }, ref) {
    const elRef = useRef<HTMLDivElement | null>(null);
    const wsRef = useRef<WebSocket | null>(null);

    useImperativeHandle(ref, () => ({
      send(line: string) {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data: line.endsWith('\r') ? line : line + '\r' }));
        }
      },
    }));

    useEffect(() => {
      if (!elRef.current) return;

      const el = elRef.current;
      let term: XTerm | null = null;
      let fit: FitAddon | null = null;
      let ws: WebSocket | null = null;
      let disposed = false;
      let onDataDisposable: ReturnType<XTerm['onData']> | null = null;

      // Defer the actual init until the container has nonzero dimensions —
      // xterm's renderer reads them up front and throws
      // `Cannot read properties of undefined (reading 'dimensions')`
      // if the element is still 0×0 (the case during React 18 StrictMode
      // double-mount, or before the parent has laid out).
      let rafHandle = 0;
      const safeFit = () => {
        if (!fit || disposed) return;
        try {
          fit.fit();
        } catch {
          // The renderer may still be coming up; ignore and let the resize
          // observer try again on the next paint.
        }
      };

      const init = () => {
        if (disposed) return;
        if (!el.isConnected || el.clientWidth === 0 || el.clientHeight === 0) {
          rafHandle = requestAnimationFrame(init);
          return;
        }

        term = new XTerm({
          convertEol: true,
          cursorBlink: true,
          fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
          fontSize: 13,
          theme: { background: '#0f172a', foreground: '#e2e8f0', cursor: '#38bdf8' },
        });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(el);
        // One more frame so the renderer measures the cell before we fit.
        rafHandle = requestAnimationFrame(() => {
          safeFit();
          openWs();
        });
      };

      const openWs = () => {
        if (!term || disposed) return;
        const wsUrl =
          (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
          window.location.host +
          '/ws/terminal';
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!term || !ws) return;
          term.writeln('\x1b[36m[connected to /ws/terminal]\x1b[0m');
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        };
        ws.onmessage = (ev) => {
          if (!term) return;
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'data') term.write(msg.data);
            else if (msg.type === 'exit')
              term.writeln(`\r\n\x1b[33m[exited code=${msg.exitCode}]\x1b[0m`);
          } catch {
            /* ignore */
          }
        };
        ws.onclose = () => term?.writeln('\r\n\x1b[31m[connection closed]\x1b[0m');
        ws.onerror = () => term?.writeln('\r\n\x1b[31m[connection error]\x1b[0m');

        onDataDisposable = term.onData((d) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'data', data: d }));
          }
        });
      };

      // Refit on container resize (parent layout changes) as well as window resize.
      const ro = new ResizeObserver(() => {
        if (!term) return;
        safeFit();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      });
      ro.observe(el);

      init();

      return () => {
        disposed = true;
        cancelAnimationFrame(rafHandle);
        ro.disconnect();
        onDataDisposable?.dispose();
        try { ws?.close(); } catch { /* ignore */ }
        try { term?.dispose(); } catch { /* ignore */ }
        wsRef.current = null;
      };
    }, []);

    return (
      <div
        ref={elRef}
        style={{
          height,
          minHeight: 200,
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: 8,
          background: '#0f172a',
          overflow: 'hidden',
        }}
      />
    );
  },
);
