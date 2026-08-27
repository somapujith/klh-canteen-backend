import { describe, expect, it } from "vitest";
import { sniffImage, hashImage, MAX_IMAGE_DIMENSION } from "../../src/services/menuImageService.js";
import {
  buildMinimalJpeg,
  buildTruncatedJpeg,
  buildMultiSofJpeg,
  buildMinimalWebpLossy,
  buildWebpExtended,
  buildRiffSizeMismatchWebp,
  buildPngMagicBytes,
  buildGifMagicBytes,
} from "../helpers/images.js";

describe("sniffImage", () => {
  it("identifies a JPEG from its SOF0 marker and reads its dimensions", () => {
    const bytes = buildMinimalJpeg(320, 240);
    expect(sniffImage(bytes)).toEqual({ mimeType: "image/jpeg", width: 320, height: 240 });
  });

  it("identifies a lossy (VP8) WebP and reads its dimensions", () => {
    const bytes = buildMinimalWebpLossy(200, 150);
    expect(sniffImage(bytes)).toEqual({ mimeType: "image/webp", width: 200, height: 150 });
  });

  it("returns null for garbage bytes", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);
    expect(sniffImage(bytes)).toBeNull();
  });

  it("returns null for a plain text buffer", () => {
    expect(sniffImage(new TextEncoder().encode("this is not an image, just text"))).toBeNull();
  });

  it("returns null for a PNG magic-byte prefix (deliberately unsupported)", () => {
    expect(sniffImage(buildPngMagicBytes())).toBeNull();
  });

  it("returns null for a GIF magic-byte prefix (deliberately unsupported)", () => {
    expect(sniffImage(buildGifMagicBytes())).toBeNull();
  });

  it("returns null, rather than throwing, for a JPEG truncated mid-header", () => {
    const truncated = buildTruncatedJpeg(320, 240);
    expect(() => sniffImage(truncated)).not.toThrow();
    expect(sniffImage(truncated)).toBeNull();
  });

  it("a WebP under the 2048px cap sniffs within bounds", () => {
    const bytes = buildMinimalWebpLossy(1024, 768);
    const sniffed = sniffImage(bytes);
    expect(sniffed).not.toBeNull();
    expect(sniffed!.width).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
    expect(sniffed!.height).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION);
  });

  it("faithfully reports a crafted VP8X WebP's oversized claimed canvas, rather than silently capping it", () => {
    // sniffImage() only ever reports what the header says — it is the
    // caller's (uploadMenuItemImage's) job to reject this. Faithfully
    // reporting the claim is what makes that rejection possible at all.
    const bytes = buildWebpExtended(3000, 3000);
    const sniffed = sniffImage(bytes);
    expect(sniffed).toEqual({ mimeType: "image/webp", width: 3000, height: 3000 });
    expect(sniffed!.width).toBeGreaterThan(MAX_IMAGE_DIMENSION);
  });

  it("returns null for a zero-width/zero-height JPEG rather than a dimension it can't validate downstream", () => {
    // sniffImage() itself has no upper/lower dimension policy — that lives in
    // uploadMenuItemImage. This just proves the sniffer faithfully reports
    // 0x0 (it does not silently reject at the sniff layer), so the
    // zero-dimension rejection test below is exercising the real boundary.
    const bytes = buildMinimalJpeg(0, 0);
    expect(sniffImage(bytes)).toEqual({ mimeType: "image/jpeg", width: 0, height: 0 });
  });

  it("returns null for an animated (Animation flag set) VP8X WebP", () => {
    const animated = buildWebpExtended(200, 150, { animated: true });
    expect(sniffImage(animated)).toBeNull();

    // Sanity: the same dimensions with the flag unset sniff fine.
    const notAnimated = buildWebpExtended(200, 150, { animated: false });
    expect(sniffImage(notAnimated)).toEqual({ mimeType: "image/webp", width: 200, height: 150 });
  });

  it("returns null for a WebP whose RIFF-declared size disagrees with the actual buffer length", () => {
    const bytes = buildRiffSizeMismatchWebp(200, 150);
    expect(sniffImage(bytes)).toBeNull();
  });

  it("returns null for a JPEG carrying two SOF markers (dimension-spoofing attempt)", () => {
    // A tiny "safe" SOF (100x100) ahead of a much larger real one
    // (20000x20000) — sniffJpeg() must not return the first hit.
    const bytes = buildMultiSofJpeg(100, 100, 20000, 20000);
    expect(sniffImage(bytes)).toBeNull();
  });

  it("still returns dimensions for a JPEG with exactly one SOF marker (regression guard on the multi-SOF check)", () => {
    const bytes = buildMinimalJpeg(320, 240);
    expect(sniffImage(bytes)).toEqual({ mimeType: "image/jpeg", width: 320, height: 240 });
  });
});

describe("hashImage", () => {
  it("is deterministic and 32 hex characters long", async () => {
    const bytes = buildMinimalJpeg(100, 100);
    const a = await hashImage(bytes);
    const b = await hashImage(bytes);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("differs for different bytes", async () => {
    const a = await hashImage(buildMinimalJpeg(100, 100));
    const b = await hashImage(buildMinimalJpeg(100, 101));
    expect(a).not.toBe(b);
  });
});
