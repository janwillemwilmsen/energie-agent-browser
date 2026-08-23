import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

// Bulk download of run screenshots as a zip (Screenshots page → "Download").
//
// The client posts the runs (and optionally which screenshot files of each)
// it is currently showing; we stream back a zip laid out as
//   <scenario>/<YYYY-MM-DD>-run<id>/<screenshot>.png
// The zip uses the "store" method (no compression): PNGs are already
// compressed and it lets us stream without buffering the whole archive or
// pulling in a dependency. Each entry is read once to compute its CRC-32.

const Body = z.object({
  items: z
    .array(
      z.object({
        runId: z.number().int().positive(),
        // Omit to include every screenshot of the run.
        names: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(1)
    .max(2000),
});

// ---- CRC-32 (IEEE, same as zlib) -------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- Minimal zip writer (store only, streaming) -----------------------------
// MS-DOS date/time fields as the zip spec wants them.
function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

interface ZipEntry {
  name: Buffer; // UTF-8 file name
  crc: number;
  size: number;
  offset: number; // of the local header
  dosDate: number;
  dosTime: number;
}

function localHeader(e: ZipEntry): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); // local file header signature
  h.writeUInt16LE(20, 4); // version needed (2.0)
  h.writeUInt16LE(0x0800, 6); // general purpose: UTF-8 names
  h.writeUInt16LE(0, 8); // method: store
  h.writeUInt16LE(e.dosTime, 10);
  h.writeUInt16LE(e.dosDate, 12);
  h.writeUInt32LE(e.crc, 14);
  h.writeUInt32LE(e.size, 18); // compressed
  h.writeUInt32LE(e.size, 22); // uncompressed
  h.writeUInt16LE(e.name.length, 26);
  h.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([h, e.name]);
}

function centralHeader(e: ZipEntry): Buffer {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0); // central directory header signature
  h.writeUInt16LE(20, 4); // version made by
  h.writeUInt16LE(20, 6); // version needed
  h.writeUInt16LE(0x0800, 8); // UTF-8 names
  h.writeUInt16LE(0, 10); // store
  h.writeUInt16LE(e.dosTime, 12);
  h.writeUInt16LE(e.dosDate, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(e.size, 20);
  h.writeUInt32LE(e.size, 24);
  h.writeUInt16LE(e.name.length, 28);
  h.writeUInt16LE(0, 30); // extra
  h.writeUInt16LE(0, 32); // comment
  h.writeUInt16LE(0, 34); // disk number start
  h.writeUInt16LE(0, 36); // internal attrs
  h.writeUInt32LE(0, 38); // external attrs
  h.writeUInt32LE(e.offset, 42);
  return Buffer.concat([h, e.name]);
}

function endOfCentralDir(count: number, cdSize: number, cdOffset: number): Buffer {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(0x06054b50, 0);
  h.writeUInt16LE(0, 4); // this disk
  h.writeUInt16LE(0, 6); // disk with CD
  h.writeUInt16LE(count, 8);
  h.writeUInt16LE(count, 10);
  h.writeUInt32LE(cdSize, 12);
  h.writeUInt32LE(cdOffset, 16);
  h.writeUInt16LE(0, 20); // comment length
  return h;
}

interface ZipSource {
  entryName: string;
  absPath: string;
}

// Plain (non-Zip64) zip limits. Far above anything this app produces, but
// guard so a broken archive is never emitted silently.
const MAX_ENTRIES = 65000;
const MAX_BYTES = 0xffffffff - 1024 * 1024;

async function* zipChunks(sources: ZipSource[]): AsyncGenerator<Buffer> {
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (const src of sources) {
    let data: Buffer;
    let mtime: Date;
    try {
      data = fs.readFileSync(src.absPath);
      mtime = fs.statSync(src.absPath).mtime;
    } catch {
      continue; // vanished between listing and zipping — skip it
    }
    const { date, time } = dosDateTime(mtime);
    const e: ZipEntry = {
      name: Buffer.from(src.entryName, 'utf8'),
      crc: crc32(data),
      size: data.length,
      offset,
      dosDate: date,
      dosTime: time,
    };
    const lh = localHeader(e);
    yield lh;
    yield data;
    offset += lh.length + data.length;
    entries.push(e);
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const e of entries) {
    const ch = centralHeader(e);
    cdSize += ch.length;
    yield ch;
  }
  yield endOfCentralDir(entries.length, cdSize, cdStart);
}

function safeSegment(s: string): string {
  // Path segment for inside the zip: strip separators/control chars, keep it short.
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim();
  return (cleaned || 'unnamed').slice(0, 80);
}

interface RunRow {
  id: number;
  scenario_id: number;
  started_at: string;
  screenshot_paths_json: string;
  scenario_name: string | null;
}

export async function screenshotsZipRoutes(app: FastifyInstance) {
  app.post('/api/screenshots/zip', async (req, reply) => {
    const { items } = Body.parse(req.body);
    const db = getDb();
    const getRun = db.prepare(
      `SELECT runs.id, runs.scenario_id, runs.started_at, runs.screenshot_paths_json,
              scenarios.name AS scenario_name
       FROM runs LEFT JOIN scenarios ON scenarios.id = runs.scenario_id
       WHERE runs.id = ?`,
    );

    const sources: ZipSource[] = [];
    const used = new Set<string>();
    let totalBytes = 0;
    for (const it of items) {
      const run = getRun.get(it.runId) as RunRow | undefined;
      if (!run) continue;
      let all: string[] = [];
      try { all = JSON.parse(run.screenshot_paths_json); } catch { /* malformed */ }
      const wanted = it.names ? it.names.filter((n) => all.includes(path.basename(n))) : all;
      const day = run.started_at.slice(0, 10);
      const folder = `${safeSegment(run.scenario_name ?? `scenario-${run.scenario_id}`)}/${day}-run${run.id}`;
      for (const n of wanted) {
        const name = path.basename(n); // prevent traversal
        const abs = path.join(config.dataDir, 'screenshots', String(run.id), name);
        let size: number;
        try {
          const st = fs.statSync(abs);
          if (!st.isFile()) continue;
          size = st.size;
        } catch {
          continue;
        }
        let entryName = `${folder}/${name}`;
        // Defensive de-dupe (same file listed twice).
        if (used.has(entryName)) continue;
        used.add(entryName);
        sources.push({ entryName, absPath: abs });
        totalBytes += size;
      }
    }

    if (sources.length === 0) return reply.code(404).send({ error: 'no_screenshots' });
    if (sources.length > MAX_ENTRIES || totalBytes > MAX_BYTES) {
      return reply.code(413).send({ error: 'too_large', message: 'Narrow the selection and try again.' });
    }

    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="screenshots-${stamp}.zip"`);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Entry-Count', String(sources.length));
    return reply.send(Readable.from(zipChunks(sources)));
  });
}
