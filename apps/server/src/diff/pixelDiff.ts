import fs from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface DiffResult {
  status: 'ok' | 'size_mismatch';
  mismatchPixels: number;
  comparedPixels: number;
  ratio: number; // changed pixels / compared pixels (0..1)
  baselineWidth: number;
  baselineHeight: number;
  targetWidth: number;
  targetHeight: number;
  note?: string;
}

// Extract the top-left w×h RGBA region as a tightly-packed buffer. When the
// source already matches the target size, the original buffer is returned.
function cropTopLeft(png: PNG, w: number, h: number): Buffer {
  if (png.width === w && png.height === h) return png.data;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcStart = y * png.width * 4;
    png.data.copy(out, y * w * 4, srcStart, srcStart + w * 4);
  }
  return out;
}

// Pixel-diff two PNG files, writing the diff image to outPath. When the images
// differ in size we compare the common top-left overlap and flag the result as
// 'size_mismatch' (the chosen policy: see what changed above the fold rather
// than refusing entirely).
export function diffPngFiles(
  baselinePath: string,
  targetPath: string,
  outPath: string,
  threshold = 0.1,
): DiffResult {
  const a = PNG.sync.read(fs.readFileSync(baselinePath));
  const b = PNG.sync.read(fs.readFileSync(targetPath));

  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const sizeMismatch = a.width !== b.width || a.height !== b.height;

  const aBuf = cropTopLeft(a, w, h);
  const bBuf = cropTopLeft(b, w, h);

  const diff = new PNG({ width: w, height: h });
  const mismatchPixels = pixelmatch(aBuf, bBuf, diff.data, w, h, { threshold });
  fs.writeFileSync(outPath, PNG.sync.write(diff));

  const comparedPixels = w * h;
  return {
    status: sizeMismatch ? 'size_mismatch' : 'ok',
    mismatchPixels,
    comparedPixels,
    ratio: comparedPixels ? mismatchPixels / comparedPixels : 0,
    baselineWidth: a.width,
    baselineHeight: a.height,
    targetWidth: b.width,
    targetHeight: b.height,
    note: sizeMismatch
      ? `Sizes differ (${a.width}×${a.height} vs ${b.width}×${b.height}); compared the top-left ${w}×${h} overlap.`
      : undefined,
  };
}

export function readPngSize(filePath: string): { width: number; height: number } {
  const png = PNG.sync.read(fs.readFileSync(filePath));
  return { width: png.width, height: png.height };
}
