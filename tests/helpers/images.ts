/**
 * Minimal, hand-built JPEG/WebP byte buffers for exercising
 * src/services/menuImageService.ts's `sniffImage()` without depending on any
 * image-decoding library — the whole point of that module is that it never
 * decodes, so its tests must not either. Each buffer is only as long as the
 * bytes sniffImage() actually reads (a SOF0 marker segment for JPEG, a RIFF/
 * WEBP header + one chunk for WebP) — there is no valid entropy-coded image
 * data behind any of these, and there doesn't need to be.
 */

/**
 * A baseline JPEG: SOI, then one SOF0 (0xFFC0) marker segment carrying
 * dimensions. sniffJpeg() returns as soon as it finds the SOF marker, so
 * nothing after the width field is required.
 */
export function buildMinimalJpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x0b, // segment length (11, includes itself)
    0x08, // sample precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
  ]);
}

/** The same JPEG, cut off before the width field — sniffJpeg() must return null, not throw. */
export function buildTruncatedJpeg(width: number, height: number): Uint8Array {
  return buildMinimalJpeg(width, height).slice(0, 9);
}

/**
 * A crafted JPEG carrying TWO SOF0 marker segments: a small, safe-looking
 * one first, then a second (e.g. oversized) one. A real encoder never emits
 * two — sniffJpeg() must reject this outright rather than reporting the
 * first (attacker-chosen "safe") dimensions while a differently-sized real
 * frame follows.
 */
export function buildMultiSofJpeg(firstWidth: number, firstHeight: number, secondWidth: number, secondHeight: number): Uint8Array {
  const sof = (width: number, height: number) => [
    0xff, 0xc0, // SOF0
    0x00, 0x0b, // segment length (11, includes itself)
    0x08, // sample precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
  ];
  return new Uint8Array([
    0xff, 0xd8, // SOI
    ...sof(firstWidth, firstHeight),
    ...sof(secondWidth, secondHeight),
    0xff, 0xd9, // EOI
  ]);
}

/**
 * A lossy (VP8) WebP: "RIFF"/"WEBP"/"VP8 " headers, a 3-byte frame tag
 * (contents irrelevant to the sniffer), the VP8 start code (0x9d 0x01 0x2a),
 * then two 14-bit little-endian dimension fields.
 *
 * The RIFF size field (bytes 4-7) IS validated by sniffImage() — it must
 * equal total length minus 8 — so it's computed here rather than left as a
 * placeholder.
 */
export function buildMinimalWebpLossy(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(asciiBytes("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(asciiBytes("WEBP"), 8);
  bytes.set(asciiBytes("VP8 "), 12);
  // bytes[16..19]: VP8 chunk size (unchecked)
  // bytes[20..22]: frame tag (unchecked)
  bytes[23] = 0x9d;
  bytes[24] = 0x01;
  bytes[25] = 0x2a;
  bytes[26] = width & 0xff;
  bytes[27] = (width >> 8) & 0x3f;
  bytes[28] = height & 0xff;
  bytes[29] = (height >> 8) & 0x3f;
  return bytes;
}

/**
 * An extended-format (VP8X) WebP, whose canvas size is a direct 3-byte LE
 * (dimension - 1) field — this is the format an attacker would use to claim
 * a canvas far larger than the actual coded image, since VP8X carries no
 * pixel data to cross-check against.
 *
 * The RIFF size field (bytes 4-7) IS validated by sniffImage() — it must
 * equal total length minus 8 — so it's computed here rather than left as a
 * placeholder. The Animation flag (flags byte, bit 0x02) is left unset so
 * this still sniffs as a valid static image by default; pass
 * `animated: true` to build the animated-rejection fixture.
 */
export function buildWebpExtended(width: number, height: number, options: { animated?: boolean } = {}): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(asciiBytes("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(asciiBytes("WEBP"), 8);
  bytes.set(asciiBytes("VP8X"), 12);
  // bytes[16..19]: VP8X chunk size (unchecked)
  bytes[20] = options.animated ? 0x02 : 0x00; // flags byte, bit 0x02 = Animation
  // bytes[21..23]: reserved (unchecked)
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

/**
 * A VP8X WebP whose RIFF-declared size (bytes 4-7) does NOT match the actual
 * buffer length — the signature a polyglot would produce (valid-looking
 * header + arbitrary trailing attacker payload, or a truncated/padded file).
 * sniffImage() must reject this before it even reaches the per-chunk-type
 * dimension parsing.
 */
export function buildRiffSizeMismatchWebp(width: number, height: number): Uint8Array {
  const bytes = buildWebpExtended(width, height);
  // Corrupt the declared size so it disagrees with the true length.
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8 + 100, true);
  return bytes;
}

/**
 * Just the 8-byte PNG signature — sniffImage() deliberately has no PNG
 * branch at all, so no header fields beyond the magic bytes are needed to
 * prove it's rejected.
 */
export function buildPngMagicBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

/** The GIF87a/89a magic bytes — same reasoning as buildPngMagicBytes(). */
export function buildGifMagicBytes(): Uint8Array {
  return new Uint8Array([...asciiBytes("GIF89a"), 0x00, 0x00]);
}

function asciiBytes(text: string): Uint8Array {
  return new Uint8Array([...text].map((ch) => ch.charCodeAt(0)));
}
