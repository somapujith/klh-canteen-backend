import crypto from "node:crypto";

const MAGIC_PREFIX = "KLHC1";
const MAX_TOKEN_AGE_SECONDS = 24 * 60 * 60; // 24h — order token expires after this

function sign(orderId: string, issuedAt: number, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${MAGIC_PREFIX}.${orderId}.${issuedAt}`)
    .digest("base64url");
}

export function signOrderToken(orderId: string, secret: string): string {
  if (!secret) throw new Error("QR_TOKEN_SECRET not set");
  const issuedAt = Math.floor(Date.now() / 1000);
  const sig = sign(orderId, issuedAt, secret);
  const payload = `${MAGIC_PREFIX}.${orderId}.${issuedAt}.${sig}`;
  return Buffer.from(payload).toString("base64url");
}

export function verifyOrderToken(token: string, secret: string): string | null {
  try {
    if (!secret) throw new Error("QR_TOKEN_SECRET not set");
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(".");
    if (parts.length !== 4) return null;
    const [prefix, orderId, issuedAtStr, sig] = parts;
    if (prefix !== MAGIC_PREFIX) return null;

    const issuedAt = Number(issuedAtStr);
    if (!Number.isFinite(issuedAt)) return null;
    const ageSeconds = Math.floor(Date.now() / 1000) - issuedAt;
    if (ageSeconds < 0 || ageSeconds > MAX_TOKEN_AGE_SECONDS) return null;

    const expectedSig = sign(orderId, issuedAt, secret);
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    return orderId;
  } catch {
    return null;
  }
}
