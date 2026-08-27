/**
 * Validates and stores admin-uploaded menu item photos.
 *
 * The client (Canteen-Frontend/src/lib/imageEncode.ts) is the source of
 * truth for resizing/compression — Workers has no native image library and
 * bundling a WASM codec risks the 3MB/10MB deploy limit for every route in
 * this backend, not just this one. This service therefore never decodes an
 * image; it only sniffs the file header (a handful of bytes) to confirm the
 * format and dimensions match what the client claims, then stores the bytes
 * as-is. See docs/adr (architect output) for the full trade-off writeup.
 */
import type { Pool } from "@neondatabase/serverless";
import { ApiError } from "../middleware/errorHandler.js";
import * as menuItemRepo from "../db/menuItemRepo.js";
import * as menuItemImageRepo from "../db/menuItemImageRepo.js";

/** Mirrors the "MenuItemImage" CHECK constraint — the source of truth is the DB. */
export const MAX_STORED_IMAGE_BYTES = 512 * 1024;
export const MAX_IMAGE_DIMENSION = 2048;

export interface SniffedImage {
  mimeType: "image/webp" | "image/jpeg";
  width: number;
  height: number;
}

/**
 * Identifies format + dimensions from magic bytes and header fields only —
 * never trusts the multipart part's declared `type`, which is fully
 * attacker-controlled. Returns null for anything else, including formats we
 * deliberately never accept (SVG: XML, can carry script; GIF: animation/
 * frame-bomb surface neither of which a static menu photo needs).
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  return sniffJpeg(bytes) ?? sniffWebp(bytes);
}

function sniffJpeg(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;

  // Walk the ENTIRE marker segment chain (to EOI or end of buffer) rather
  // than returning on the first SOF found. A legitimately-encoded JPEG has
  // exactly one Start-Of-Frame marker; a crafted file can smuggle a tiny fake
  // SOF (small, safe-looking dimensions) ahead of the real SOF (declaring
  // oversized dimensions), and returning early on the first hit would report
  // the fake, safe dimensions while the actual oversized frame follows. Collect
  // every SOF found and reject outright if there is more than one — a real
  // encoder never emits two. DHT (0xC4), JPG (0xC8), DAC (0xCC) are excluded
  // from the SOF marker set — they share the marker range but aren't frame
  // headers.
  const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let pos = 2;
  let found: SniffedImage | null = null;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) return null;
    const marker = bytes[pos + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xd9) break; // EOI — stop walking, return whatever SOF (if any) was found
    const segmentLength = (bytes[pos + 2]! << 8) | bytes[pos + 3]!;
    if (SOF_MARKERS.has(marker)) {
      if (pos + 9 > bytes.length) return null;
      if (found) return null; // a second SOF marker — reject as invalid/crafted
      const height = (bytes[pos + 5]! << 8) | bytes[pos + 6]!;
      const width = (bytes[pos + 7]! << 8) | bytes[pos + 8]!;
      found = { mimeType: "image/jpeg", width, height };
    }
    pos += 2 + segmentLength;
  }
  return found;
}

function sniffWebp(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 30) return null;
  if (!hasAscii(bytes, 0, "RIFF") || !hasAscii(bytes, 8, "WEBP")) return null;

  const chunkId = asciiAt(bytes, 12, 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // RIFF header bytes 4-7 are a little-endian 32-bit size field meaning
  // "total file size minus 8" (the RIFF fourCC + size field itself). Real
  // encoders always produce this exactly; requiring an exact match closes off
  // "valid-looking header + arbitrary trailing attacker payload" (a polyglot
  // whose appended payload would make the true length disagree with the
  // declared RIFF size) for all three chunk types below, so it's checked once,
  // early, before branching on chunk type.
  const declaredSize = view.getUint32(4, true);
  if (declaredSize !== bytes.length - 8) return null;

  if (chunkId === "VP8 ") {
    // Lossy: 3-byte frame tag + 3-byte start code (0x9d 0x01 0x2a), then two
    // 14-bit little-endian dimensions.
    if (bytes[20 + 3] !== 0x9d || bytes[20 + 4] !== 0x01 || bytes[20 + 5] !== 0x2a) return null;
    const width = view.getUint16(20 + 6, true) & 0x3fff;
    const height = view.getUint16(20 + 8, true) & 0x3fff;
    return { mimeType: "image/webp", width, height };
  }

  if (chunkId === "VP8L") {
    // Lossless: signature byte 0x2F, then a 4-byte LE bitfield packing
    // (width-1) in the low 14 bits and (height-1) in the next 14 bits.
    if (bytes[20] !== 0x2f) return null;
    const bits = view.getUint32(21, true);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { mimeType: "image/webp", width, height };
  }

  if (chunkId === "VP8X") {
    // Extended: 1 flags byte + 3 reserved, then two 3-byte LE (dimension-1)
    // fields for the canvas size. Bit 0x02 of the flags byte is the Animation
    // flag — an animated WebP decodes as many frames client-side (each frame
    // can be up to the 2048px cap), a real decode-bomb risk given this gets
    // cached `immutable` for a year and served to every viewer. Reject it
    // outright rather than treating it as a static image.
    if ((bytes[20]! & 0x02) !== 0) return null;
    const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
    const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
    return { mimeType: "image/webp", width, height };
  }

  return null;
}

function hasAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  return asciiAt(bytes, offset, text.length) === text;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return "";
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]!);
  return out;
}

/**
 * First 128 bits (32 hex chars) of SHA-256 — plenty to make the URL
 * unguessable and content-addressed. Uses the global Web Crypto `crypto`
 * (available on both Workers and Node 19+) rather than `node:crypto`'s
 * default export, whose `.subtle` support varies by Node version.
 */
export async function hashImage(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Buffer.from(digest).toString("hex").slice(0, 32);
}

export interface UploadImageInput {
  menuItemId: string;
  bytes: Uint8Array;
  declaredType: string;
  uploadedById: string;
  adminKitchen?: string | null;
}

export interface UploadImageResult {
  imageHash: string;
  mimeType: "image/webp" | "image/jpeg";
  width: number;
  height: number;
  byteSize: number;
}

export async function uploadMenuItemImage(pool: Pool, input: UploadImageInput): Promise<UploadImageResult> {
  if (input.bytes.byteLength === 0) throw new ApiError(400, "INVALID_IMAGE", "Empty file.");
  if (input.bytes.byteLength > MAX_STORED_IMAGE_BYTES) {
    throw new ApiError(413, "IMAGE_TOO_LARGE", `Image must be under ${MAX_STORED_IMAGE_BYTES / 1024}KB after optimization.`);
  }

  const sniffed = sniffImage(input.bytes);
  if (!sniffed) throw new ApiError(400, "INVALID_IMAGE", "File is not a valid WebP or JPEG image.");
  if (sniffed.mimeType !== input.declaredType) {
    throw new ApiError(400, "INVALID_IMAGE", "Declared content type does not match the file's actual format.");
  }
  if (
    sniffed.width <= 0 ||
    sniffed.height <= 0 ||
    sniffed.width > MAX_IMAGE_DIMENSION ||
    sniffed.height > MAX_IMAGE_DIMENSION
  ) {
    throw new ApiError(400, "INVALID_IMAGE", `Image dimensions must be between 1 and ${MAX_IMAGE_DIMENSION}px.`);
  }

  const existing = await menuItemRepo.findMenuItemWithCategoryKitchen(pool, input.menuItemId);
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Menu item not found");
  if (input.adminKitchen && existing.categoryKitchen !== input.adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to modify this menu item.");
  }

  const hash = await hashImage(input.bytes);
  await menuItemImageRepo.putImage(pool, {
    menuItemId: input.menuItemId,
    bytes: input.bytes,
    mimeType: sniffed.mimeType,
    hash,
    width: sniffed.width,
    height: sniffed.height,
    uploadedById: input.uploadedById,
  });

  return { imageHash: hash, mimeType: sniffed.mimeType, width: sniffed.width, height: sniffed.height, byteSize: input.bytes.byteLength };
}

export async function deleteMenuItemImage(pool: Pool, menuItemId: string, adminKitchen?: string | null): Promise<void> {
  const existing = await menuItemRepo.findMenuItemWithCategoryKitchen(pool, menuItemId);
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Menu item not found");
  if (adminKitchen && existing.categoryKitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to modify this menu item.");
  }
  await menuItemImageRepo.deleteImage(pool, menuItemId);
}
