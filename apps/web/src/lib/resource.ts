import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { errorMessage } from './request.js';

// Data loading for pages: one hook for "fetch, show, refresh" and one for
// polling. Pages stop owning a load() function, a loading flag, an error slot
// and an interval each; they own what to fetch and what to render.

export interface ResourceOptions<T> {
  /** Value before the first load settles (keeps `data` non-null). */
  initial: T;
  /** Re-fetch when these change (like an effect's deps). Default: once on mount. */
  deps?: unknown[];
  /** Route load failures somewhere else instead of the hook's own error slot. */
  onError?: (message: string) => void;
}

export interface Resource<T> {
  data: T;
  /** Patch locally (after a delete, say) without a round-trip. */
  setData: Dispatch<SetStateAction<T>>;
  /** The last load failure, or whatever the page put here via setError. Cleared by a successful load. */
  error: string | null;
  setError: (message: string | null) => void;
  /** True until the first load has settled. */
  loading: boolean;
  /** True while any load is in flight (including refreshes). */
  refreshing: boolean;
  /** Fetch again; never rejects, failures land in `error` (or `onError`). */
  refresh: () => Promise<void>;
}

export function useResource<T>(fetcher: () => Promise<T>, opts: ResourceOptions<T>): Resource<T> {
  const [data, setData] = useState<T>(opts.initial);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [inflight, setInflight] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;
  const mounted = useRef(true);
  const seq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    setInflight((n) => n + 1);
    try {
      const next = await fetcherRef.current();
      // A newer load has started since; let it win.
      if (!mounted.current || mine !== seq.current) return;
      setData(next);
      setError(null);
    } catch (e) {
      if (!mounted.current || mine !== seq.current) return;
      const message = errorMessage(e);
      if (onErrorRef.current) onErrorRef.current(message);
      else setError(message);
    } finally {
      if (mounted.current) {
        setInflight((n) => n - 1);
        setLoaded(true);
      }
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the caller's
  useEffect(() => { void refresh(); }, opts.deps ?? []);

  return { data, setData, error, setError, loading: !loaded, refreshing: inflight > 0, refresh };
}

// --- Polling ------------------------------------------------------------------------------

export interface PollerHost {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  isHidden(): boolean;
}

/**
 * A timer chain that ticks every `intervalMs`, pauses while the host says it
 * is hidden, and ticks immediately when it becomes visible again. Pure enough
 * to test with a fake host.
 */
export class Poller {
  private handle: unknown = null;
  private intervalMs: number | null = null;

  constructor(
    private readonly tick: () => unknown,
    private readonly host: PollerHost,
  ) {}

  start(intervalMs: number): void {
    this.intervalMs = intervalMs;
    this.arm();
  }

  stop(): void {
    this.intervalMs = null;
    this.disarm();
  }

  /** Change the cadence; re-arms from now. */
  setInterval(intervalMs: number): void {
    if (this.intervalMs === intervalMs) return;
    this.intervalMs = intervalMs;
    this.arm();
  }

  /** Call when the host's hidden state may have changed. */
  visibilityChanged(): void {
    if (this.intervalMs == null) return;
    if (this.host.isHidden()) {
      this.disarm();
    } else if (this.handle == null) {
      void this.tick();
      this.arm();
    }
  }

  private arm(): void {
    this.disarm();
    if (this.intervalMs == null || this.host.isHidden()) return;
    this.handle = this.host.setTimeout(() => {
      this.handle = null;
      if (this.host.isHidden()) return;
      void this.tick();
      this.arm();
    }, this.intervalMs);
  }

  private disarm(): void {
    if (this.handle != null) this.host.clearTimeout(this.handle);
    this.handle = null;
  }
}

const browserHost: PollerHost = {
  setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  clearTimeout: (h) => window.clearTimeout(h as number),
  isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
};

/**
 * Call `fn` every `intervalMs` while mounted. Pauses while the tab is hidden
 * and fires once, immediately, when it becomes visible again. Pass null or 0
 * to stop. Changing the interval re-arms without a gap.
 */
export function usePolling(fn: () => unknown, intervalMs: number | null | false | undefined): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const pollerRef = useRef<Poller | null>(null);

  useEffect(() => {
    if (!intervalMs) {
      pollerRef.current?.stop();
      pollerRef.current = null;
      return;
    }
    let poller = pollerRef.current;
    if (!poller) {
      poller = new Poller(() => fnRef.current(), browserHost);
      pollerRef.current = poller;
      poller.start(intervalMs);
    } else {
      poller.setInterval(intervalMs);
    }
    const onVisibility = () => poller!.visibilityChanged();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);

  useEffect(() => () => { pollerRef.current?.stop(); pollerRef.current = null; }, []);
}
