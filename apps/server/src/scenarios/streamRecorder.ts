import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';
import { config } from '../config.js';
import { runJson } from '../agentBrowser/driver.js';

interface StreamStatus {
  connected: boolean;
  enabled: boolean;
  port: number;
  screencasting: boolean;
}

export interface StreamRecorderOptions {
  /** agent-browser --session whose live page is screencast. */
  session: string;
  /** Absolute output path for the .webm. */
  outPath: string;
  /** Progress sink (run log). */
  log?: (msg: string) => void;
}

/**
 * Records a scenario by tapping agent-browser's live CDP screencast — the
 * `stream` WebSocket — on the EXISTING (stealthed) page, and muxing the JPEG
 * frames into a .webm with ffmpeg. Unlike `agent-browser record`, this never
 * creates a fresh browser context, so the page's stealth (UA override + init
 * scripts) stays intact and WAF-protected sites (Cloudflare/CloudFront) don't
 * serve a block page into the recording.
 *
 * The screencast only emits a frame on visual change, so a constant-fps ticker
 * re-emits the most recent frame to keep the video's wall-clock duration honest
 * and hold the last frame through static stretches. If the daemon is reset
 * mid-run (scenario/preflight restart), the WebSocket auto-reconnects to the new
 * daemon's stream port without interrupting the single ffmpeg encode.
 *
 * Best-effort: construction returns null on failure rather than throwing, and a
 * dead encoder/socket never propagates into the scenario run.
 */
export class StreamRecorder {
  private ws: WebSocket | null = null;
  private readonly ticker: NodeJS.Timeout;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastFrame: Buffer | null = null;
  private received = 0;
  private stopped = false;
  private ffStderrTail = '';

  private constructor(
    private readonly session: string,
    private readonly outPath: string,
    private readonly ff: ChildProcess,
    private readonly log: (msg: string) => void,
  ) {
    this.ff.stderr?.on('data', (d) => {
      this.ffStderrTail = (this.ffStderrTail + d.toString()).slice(-2000);
    });
    // The scale+pad (in start()) normalizes any frame size (e.g. a mid-run
    // mobile-device switch) onto a fixed canvas so the encoder never chokes on
    // a resolution change.
    const periodMs = Math.max(1, Math.round(1000 / Math.max(1, config.recordingFps)));
    this.ticker = setInterval(() => {
      if (this.lastFrame && this.ff.stdin?.writable) {
        try { this.ff.stdin.write(this.lastFrame); } catch { /* EPIPE — encoder gone */ }
      }
    }, periodMs);
    void this.connect();
  }

  static async start(opts: StreamRecorderOptions): Promise<StreamRecorder | null> {
    const log = opts.log ?? (() => undefined);
    const fps = Math.max(1, config.recordingFps);
    try {
      const ff = spawn(
        config.ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'warning',
          '-f', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0',
          // The screencast frames are full-range JPEG (yuvj420p); convert to
          // limited-range yuv420p so colours render correctly and the stream
          // carries standard color tags.
          '-vf',
          'scale=1280:720:force_original_aspect_ratio=decrease:in_range=full:out_range=tv,' +
            'pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
          // VP8, NOT VP9. The Recordings page decodes with Mediabunny/WebCodecs,
          // which for VP9 has to build a full `vp09.PP.LL.DD…` codec string from
          // the bitstream's profile/level/colour and rejects ours; for VP8 the
          // codec string is simply `vp8`, which WebCodecs always supports. So
          // VP8 is what actually plays in-app (download-then-play worked either
          // way). Matches the old agent-browser/Playwright recordings.
          '-c:v', 'libvpx', '-b:v', '1M', '-crf', '12',
          '-deadline', 'realtime', '-cpu-used', '5',
          '-an', '-y', opts.outPath,
        ],
        { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
      );
      if (!ff.pid) return null;
      const rec = new StreamRecorder(opts.session, opts.outPath, ff, log);
      return rec;
    } catch (e: any) {
      log(`stream recorder: ffmpeg spawn failed (non-fatal): ${e?.message ?? e}`);
      return null;
    }
  }

  private async resolvePort(): Promise<number | null> {
    try {
      const st = await runJson<StreamStatus>(['stream', 'status'], {
        session: this.session,
        timeoutMs: 10_000,
      });
      return st?.port && st.enabled ? st.port : null;
    } catch {
      return null;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const port = await this.resolvePort();
    if (this.stopped) return;
    if (!port) {
      this.scheduleReconnect();
      return;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws = ws;
    ws.on('message', (data: WebSocket.RawData) => {
      let msg: any;
      try {
        msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
      } catch {
        return;
      }
      if (msg?.type === 'frame' && typeof msg.data === 'string') {
        this.lastFrame = Buffer.from(msg.data, 'base64');
        this.received++;
      }
    });
    ws.on('close', () => {
      if (!this.stopped) this.scheduleReconnect();
    });
    // 'error' is always followed by 'close'; reconnect is handled there.
    ws.on('error', () => undefined);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 1_000);
  }

  /**
   * Stop recording and finalize the .webm. Returns true if a non-empty file
   * landed on disk. Idempotent.
   */
  async stop(): Promise<boolean> {
    if (this.stopped) return fs.existsSync(this.outPath) && fs.statSync(this.outPath).size > 0;
    this.stopped = true;
    clearInterval(this.ticker);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    try { if (this.ff.stdin?.writable) this.ff.stdin.end(); } catch { /* ignore */ }

    const clean = await new Promise<boolean>((resolve) => {
      let settled = false;
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { this.ff.kill(); } catch { /* ignore */ }
        resolve(false);
      }, 20_000);
      this.ff.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(code === 0);
      });
    });

    const exists = fs.existsSync(this.outPath) && fs.statSync(this.outPath).size > 0;
    if ((!clean || !exists) && this.ffStderrTail.trim()) {
      this.log(`stream recorder: ffmpeg tail: ${this.ffStderrTail.trim().slice(-500)}`);
    }
    return exists;
  }

  get frameCount(): number {
    return this.received;
  }
}
