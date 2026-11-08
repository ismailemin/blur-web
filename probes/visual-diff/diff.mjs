// Per-pixel visual diff with region masks.
//
// Semantics (documented in docs/work/analysis/visual-diff.md):
//
//   delta(p)        = max(|dR|, |dG|, |dB|) in 0..255 (alpha is recorded
//                     separately, but a change of alpha alone is not a colour
//                     change for these opaque captures).
//   relative(p)     = delta(p) / max(1, max(R,G,B) over both pixels), 0..1
//   changed(p)      = delta(p) > absThreshold AND relative(p) > relThreshold
//
// The AND makes the test conservative in both directions: an absolute floor
// removes near-black dithering (a 1/255 change on a black pixel is a 100 %
// relative change), and the relative term stops a small absolute change in a
// bright area from being counted. Both thresholds are explicit command-line
// arguments with recorded defaults.
//
// Masks are axis-aligned rectangles in viewport pixels (integer). They are
// rasterised once per comparison, padded, clipped to the image, and excluded
// from every metric (mean/max/p95/changed counts). `maxDelta` is therefore the
// maximum over *compared* pixels only.

export const DEFAULT_ABS_THRESHOLD = 8;
export const DEFAULT_REL_THRESHOLD = 0.02;
export const DEFAULT_MASK_PADDING = 2;

export function normalizeMaskRect(rect, width, height, padding = DEFAULT_MASK_PADDING) {
  if (!rect || typeof rect !== 'object') throw new Error('mask rect must be an object');
  const numbers = [rect.x, rect.y, rect.w, rect.h].map(Number);
  if (numbers.some((value) => !Number.isFinite(value))) {
    throw new Error('mask rect has non-finite values: ' + JSON.stringify(rect));
  }
  const [x, y, w, h] = numbers;
  const pad = Number.isFinite(Number(padding)) ? Math.max(0, Math.floor(Number(padding))) : DEFAULT_MASK_PADDING;
  const left = Math.max(0, Math.floor(Math.min(x, x + w)) - pad);
  const top = Math.max(0, Math.floor(Math.min(y, y + h)) - pad);
  const right = Math.min(width, Math.ceil(Math.max(x, x + w)) + pad);
  const bottom = Math.min(height, Math.ceil(Math.max(y, y + h)) + pad);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Rasterise a list of rectangles into a 1-byte-per-pixel mask.
 * Returns the mask plus the normalised rectangles actually applied.
 */
export function rasterizeMasks(rects, width, height, padding = DEFAULT_MASK_PADDING) {
  const mask = new Uint8Array(width * height);
  const applied = [];
  let masked = 0;
  for (const rect of rects ?? []) {
    const normalised = normalizeMaskRect(rect, width, height, padding);
    if (!normalised) continue;
    applied.push(normalised);
    for (let y = normalised.y; y < normalised.y + normalised.h; y++) {
      const row = y * width;
      for (let x = normalised.x; x < normalised.x + normalised.w; x++) {
        if (!mask[row + x]) {
          mask[row + x] = 1;
          masked++;
        }
      }
    }
  }
  return {
    mask,
    rects: applied,
    maskedPixels: masked,
    totalPixels: width * height,
    coveredPercent: +((100 * masked) / (width * height)).toFixed(4)
  };
}

export function validateThresholds({ absThreshold, relThreshold }) {
  const abs = absThreshold === undefined ? DEFAULT_ABS_THRESHOLD : Number(absThreshold);
  const rel = relThreshold === undefined ? DEFAULT_REL_THRESHOLD : Number(relThreshold);
  if (!Number.isFinite(abs) || abs < 0 || abs > 255) {
    throw new Error('absThreshold must be a number in 0..255, got ' + absThreshold);
  }
  if (!Number.isFinite(rel) || rel < 0 || rel > 1) {
    throw new Error('relThreshold must be a number in 0..1, got ' + relThreshold);
  }
  return { absThreshold: abs, relThreshold: rel };
}

/**
 * Compare two RGBA images ({width,height,channels:4,pixels}).
 *
 * `maskRects` are excluded from every metric. The result contains the raw
 * numbers the report and the gate use; nothing is rounded except the displayed
 * percentages (the unrounded values are kept as `changedFraction`).
 */
export function compareImages(current, baseline, options = {}) {
  if (!current || !baseline) throw new Error('compareImages needs two images');
  const { absThreshold, relThreshold } = validateThresholds(options);
  const padding = options.maskPadding ?? DEFAULT_MASK_PADDING;
  const width = current.width;
  const height = current.height;
  if (baseline.width !== width || baseline.height !== height) {
    return {
      status: 'size-mismatch',
      width,
      height,
      baselineWidth: baseline.width,
      baselineHeight: baseline.height,
      absThreshold,
      relThreshold
    };
  }
  if (current.channels !== 4 || baseline.channels !== 4) {
    throw new Error('compareImages needs RGBA images (use decodePngRgba)');
  }
  const masks = rasterizeMasks(options.maskRects ?? [], width, height, padding);
  const currentPixels = current.pixels;
  const baselinePixels = baseline.pixels;
  const histogram = new Uint32Array(256);
  let changedPixels = 0;
  let changedAlphaOnly = 0;
  let absChangedPixels = 0;
  let sumDelta = 0;
  let maxDelta = 0;
  let maxAlphaDelta = 0;
  let comparedPixels = 0;
  let sumLumaDelta = 0;
  for (let index = 0, offset = 0; index < width * height; index++, offset += 4) {
    if (masks.mask[index]) continue;
    comparedPixels++;
    const dr = Math.abs(currentPixels[offset] - baselinePixels[offset]);
    const dg = Math.abs(currentPixels[offset + 1] - baselinePixels[offset + 1]);
    const db = Math.abs(currentPixels[offset + 2] - baselinePixels[offset + 2]);
    const da = Math.abs(currentPixels[offset + 3] - baselinePixels[offset + 3]);
    const delta = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
    if (delta) {
      histogram[delta]++;
      sumDelta += delta;
      sumLumaDelta += 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
      if (delta > maxDelta) maxDelta = delta;
      if (delta > absThreshold) absChangedPixels++;
      const maxChannel = Math.max(
        currentPixels[offset], currentPixels[offset + 1], currentPixels[offset + 2],
        baselinePixels[offset], baselinePixels[offset + 1], baselinePixels[offset + 2]
      );
      if (delta > absThreshold && delta / Math.max(1, maxChannel) > relThreshold) changedPixels++;
      else if (delta <= absThreshold && da > absThreshold) changedAlphaOnly++;
    }
    if (da > maxAlphaDelta) maxAlphaDelta = da;
  }
  let p95 = 0;
  let p99 = 0;
  if (comparedPixels > 0) {
    const p95Target = Math.ceil(comparedPixels * 0.95);
    const p99Target = Math.ceil(comparedPixels * 0.99);
    let running = 0;
    for (let value = 1; value < 256; value++) {
      running += histogram[value];
      if (!p95 && running >= p95Target) p95 = value;
      if (!p99 && running >= p99Target) p99 = value;
      if (p95 && p99) break;
    }
  }
  return {
    status: comparedPixels === 0 ? 'masked-empty' : changedPixels === 0 ? 'match' : 'differs',
    width,
    height,
    absThreshold,
    relThreshold,
    totalPixels: width * height,
    comparedPixels,
    maskedPixels: masks.maskedPixels,
    changedPixels,
    changedFraction: comparedPixels ? changedPixels / comparedPixels : 0,
    changedPercent: comparedPixels ? +((100 * changedPixels) / comparedPixels).toFixed(6) : 0,
    absChangedPixels,
    changedAlphaOnly,
    maxDelta,
    maxAlphaDelta,
    meanDelta: comparedPixels ? +(sumDelta / comparedPixels).toFixed(6) : 0,
    meanLumaDelta: comparedPixels ? +(sumLumaDelta / comparedPixels).toFixed(6) : 0,
    p95Delta: p95,
    p99Delta: p99,
    masks
  };
}

/**
 * Build a visual diff image: the current frame dimmed to 25 %, changed pixels
 * in opaque red, masked pixels tinted blue-grey so the reviewer sees what was
 * excluded. Returns RGBA pixels ready for `encodePng`.
 */
export function buildDiffImage(current, baseline, diff, options = {}) {
  if (diff.status === 'size-mismatch') throw new Error('cannot build a diff image from a size mismatch');
  const { width, height } = diff;
  const { absThreshold, relThreshold } = validateThresholds(options);
  const maskRects = options.maskRects ?? [];
  const masks = rasterizeMasks(maskRects, width, height, options.maskPadding ?? DEFAULT_MASK_PADDING);
  const out = Buffer.alloc(width * height * 4, 255);
  const currentPixels = current.pixels;
  const baselinePixels = baseline.pixels;
  for (let index = 0, offset = 0; index < width * height; index++, offset += 4) {
    const r = currentPixels[offset];
    const g = currentPixels[offset + 1];
    const b = currentPixels[offset + 2];
    if (masks.mask[index]) {
      out[offset] = (r * 0.2 + 40) & 255;
      out[offset + 1] = (g * 0.2 + 46) & 255;
      out[offset + 2] = (b * 0.2 + 58) & 255;
      out[offset + 3] = 255;
      continue;
    }
    const delta = Math.max(
      Math.abs(r - baselinePixels[offset]),
      Math.abs(g - baselinePixels[offset + 1]),
      Math.abs(b - baselinePixels[offset + 2])
    );
    const maxChannel = Math.max(r, g, b, baselinePixels[offset], baselinePixels[offset + 1], baselinePixels[offset + 2]);
    const changed = delta > absThreshold && delta / Math.max(1, maxChannel) > relThreshold;
    if (changed) {
      out[offset] = 255;
      out[offset + 1] = 32;
      out[offset + 2] = 32;
      out[offset + 3] = 255;
    } else {
      out[offset] = (r * 0.25) & 255;
      out[offset + 1] = (g * 0.25) & 255;
      out[offset + 2] = (b * 0.25) & 255;
      out[offset + 3] = 255;
    }
  }
  return { width, height, channels: 4, pixels: out };
}

/**
 * Convert a list of `{selector, rect}` records produced by the capture page into
 * plain mask rectangles. A record without a usable rect (element hidden) is
 * dropped and reported as a warning instead of failing the comparison.
 */
export function maskRectsFromCapture(records, label = 'scene') {
  const rects = [];
  const warnings = [];
  for (const record of records ?? []) {
    if (!record || !record.rect) {
      warnings.push(label + ': mask ' + JSON.stringify(record?.selector ?? null) + ' has no rect (element hidden)');
      continue;
    }
    const { x, y, w, h } = record.rect;
    if (![x, y, w, h].every((value) => Number.isFinite(value)) || w <= 0 || h <= 0) {
      warnings.push(label + ': mask ' + JSON.stringify(record.selector ?? null) + ' has an empty rect');
      continue;
    }
    rects.push({ x, y, w, h, selector: record.selector ?? null });
  }
  return { rects, warnings };
}
