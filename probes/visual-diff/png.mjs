// Minimal PNG codec for the visual-diff harness.
//
// Decoding: 8-bit PNG, colour type 0 (grey), 2 (RGB) or 6 (RGBA), no
// interlacing, all five scanline filters. That is exactly what Chromium/Edge
// emits for `Page.captureScreenshot`, and it is a deliberately small surface so
// an unexpected image fails loudly instead of being half-decoded.
//
// Encoding: 8-bit RGBA, filter 0 per row. Used for the diff images; the bytes
// are deterministic for a given pixel buffer (one deflate stream, fixed level).
//
// No dependency is added: `node:zlib` is the only import.

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'ascii');
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, crcBuffer]);
}

/**
 * Decode an 8-bit PNG into raw bytes.
 * Returns `{ width, height, channels, pixels }` where `pixels` is packed
 * row-major. Grey is expanded to RGBA by `decodePngRgba`.
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG (bad signature)');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  let sawIhdr = false;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (offset + 12 + length > buffer.length) throw new Error('truncated PNG chunk at byte ' + offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (length !== 13) throw new Error('bad IHDR length ' + length);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
      sawIhdr = true;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!sawIhdr) throw new Error('PNG has no IHDR');
  if (width <= 0 || height <= 0) throw new Error('PNG has an empty image (' + width + 'x' + height + ')');
  if (bitDepth !== 8) throw new Error('unsupported PNG bit depth ' + bitDepth + ' (only 8)');
  if (colourType !== 0 && colourType !== 2 && colourType !== 6) {
    throw new Error('unsupported PNG colour type ' + colourType + ' (only grey/RGB/RGBA)');
  }
  if (interlace !== 0) throw new Error('unsupported interlaced PNG');
  if (!idat.length) throw new Error('PNG has no IDAT');
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 1;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) {
    throw new Error('PNG data length ' + raw.length + ' != expected ' + height * (stride + 1));
  }
  const pixels = Buffer.alloc(width * height * channels);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    if (filter > 4) throw new Error('unsupported PNG filter ' + filter + ' on row ' + y);
    const source = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const rowStart = y * stride;
    const previousStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const above = y > 0 ? pixels[previousStart + x] : 0;
      const corner = y > 0 && x >= channels ? pixels[previousStart + x - channels] : 0;
      let value = source[x];
      if (filter === 1) value = (value + left) & 255;
      else if (filter === 2) value = (value + above) & 255;
      else if (filter === 3) value = (value + ((left + above) >> 1)) & 255;
      else if (filter === 4) {
        const estimate = left + above - corner;
        const da = Math.abs(estimate - left);
        const db = Math.abs(estimate - above);
        const dc = Math.abs(estimate - corner);
        value = (value + (da <= db && da <= dc ? left : db <= dc ? above : corner)) & 255;
      }
      pixels[rowStart + x] = value;
    }
  }
  return { width, height, channels, pixels };
}

/** Decode to RGBA (alpha 255 for images without an alpha channel). */
export function decodePngRgba(buffer) {
  const image = decodePng(buffer);
  if (image.channels === 4) return image;
  const { width, height, channels, pixels } = image;
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let index = 0, source = 0, target = 0; index < width * height; index++, source += channels, target += 4) {
    if (channels === 3) {
      rgba[target] = pixels[source];
      rgba[target + 1] = pixels[source + 1];
      rgba[target + 2] = pixels[source + 2];
    } else {
      rgba[target] = pixels[source];
      rgba[target + 1] = pixels[source];
      rgba[target + 2] = pixels[source];
    }
  }
  return { width, height, channels: 4, pixels: rgba };
}

/**
 * Encode RGBA pixels as an 8-bit PNG. `pixels` must be `width * height * 4`
 * bytes (alpha is kept so a future mask overlay can use it).
 */
export function encodePng({ width, height, pixels }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('encodePng needs positive integer dimensions');
  }
  if (!pixels || pixels.length !== width * height * 4) {
    throw new Error('encodePng needs width*height*4 RGBA bytes, got ' + (pixels ? pixels.length : 'none'));
  }
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Solid RGBA image helper (tests and diff-image backgrounds). */
export function createPng({ width, height, rgba = [0, 0, 0, 255] }) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    pixels[index * 4] = rgba[0];
    pixels[index * 4 + 1] = rgba[1];
    pixels[index * 4 + 2] = rgba[2];
    pixels[index * 4 + 3] = rgba[3];
  }
  return encodePng({ width, height, pixels });
}
