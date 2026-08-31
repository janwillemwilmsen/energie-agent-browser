import fs from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';

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

interface RawImage {
  width: number;
  height: number;
  data: Buffer;
}

// Decode any supported screenshot format (png/jpeg/webp) into tightly-packed
// RGBA. sharp auto-detects the container from the bytes, so the diff pipeline
// no longer assumes PNG sources.
async function readRaw(filePath: string): Promise<RawImage> {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

// Extract the top-left w×h RGBA region as a tightly-packed buffer. When the
// source already matches the target size, the original buffer is returned.
function cropTopLeft(img: RawImage, w: number, h: number): Buffer {
  if (img.width === w && img.height === h) return img.data;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcStart = y * img.width * 4;
    img.data.copy(out, y * w * 4, srcStart, srcStart + w * 4);
  }
  return out;
}

// Pixel-diff two image files (png/jpeg/webp), writing the diff image — always
// a PNG — to outPath. When the images differ in size we compare the common
// top-left overlap and flag the result as 'size_mismatch' (the chosen policy:
// see what changed above the fold rather than refusing entirely).
export async function diffImageFiles(
  baselinePath: string,
  targetPath: string,
  outPath: string,
  threshold = 0.1,
): Promise<DiffResult> {
  const a = await readRaw(baselinePath);
  const b = await readRaw(targetPath);

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

export async function readImageSize(filePath: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(filePath).metadata();
  if (!meta.width || !meta.height) throw new Error(`could not read image size: ${filePath}`);
  return { width: meta.width, height: meta.height };
}
