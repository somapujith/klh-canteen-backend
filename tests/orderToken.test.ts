import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { signOrderToken, verifyOrderToken } from "../src/lib/orderToken.js";

const SECRET = process.env.QR_TOKEN_SECRET!;

describe("orderToken", () => {
  it("round-trips a freshly signed token", () => {
    const token = signOrderToken("order-123", SECRET);
    expect(verifyOrderToken(token, SECRET)).toBe("order-123");
  });

  it("rejects a token with a flipped signature byte (forgery attempt)", () => {
    const token = signOrderToken("order-123", SECRET);
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [prefix, orderId, issuedAt, sig] = decoded.split(".");
    const tamperedSig = sig.slice(0, -1) + (sig.at(-1) === "a" ? "b" : "a");
    const tampered = Buffer.from(`${prefix}.${orderId}.${issuedAt}.${tamperedSig}`).toString("base64url");
    expect(verifyOrderToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a token for a different orderId than it was signed for", () => {
    const token = signOrderToken("order-123", SECRET);
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [prefix, , issuedAt, sig] = decoded.split(".");
    const swapped = Buffer.from(`${prefix}.order-999.${issuedAt}.${sig}`).toString("base64url");
    expect(verifyOrderToken(swapped, SECRET)).toBeNull();
  });

  it("rejects an expired token (older than 24h)", () => {
    const realNow = Date.now;
    Date.now = () => realNow() - 25 * 60 * 60 * 1000;
    const oldToken = signOrderToken("order-123", SECRET);
    Date.now = realNow;
    expect(verifyOrderToken(oldToken, SECRET)).toBeNull();
  });

  it("rejects garbage input that isn't valid base64url or has wrong shape", () => {
    expect(verifyOrderToken("not-a-token", SECRET)).toBeNull();
    expect(verifyOrderToken("", SECRET)).toBeNull();
  });

  it("rejects a token with a foreign/wrong magic prefix (token from another app)", () => {
    const token = signOrderToken("order-123", SECRET);
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [, orderId, issuedAt, sig] = decoded.split(".");
    const foreign = Buffer.from(`EVILAPP.${orderId}.${issuedAt}.${sig}`).toString("base64url");
    expect(verifyOrderToken(foreign, SECRET)).toBeNull();
  });

  it("rejects a token forged with a different secret than QR_TOKEN_SECRET", () => {
    const orderId = "order-123";
    const issuedAt = Math.floor(Date.now() / 1000);
    const forgedSig = crypto
      .createHmac("sha256", "attacker-guessed-secret")
      .update(`KLHC1.${orderId}.${issuedAt}`)
      .digest("base64url");
    const forged = Buffer.from(`KLHC1.${orderId}.${issuedAt}.${forgedSig}`).toString("base64url");
    expect(verifyOrderToken(forged, SECRET)).toBeNull();
  });

  it("rejects a completely fabricated token with no valid signature at all", () => {
    const fabricated = Buffer.from("KLHC1.order-123.9999999999.totally-made-up-signature").toString("base64url");
    expect(verifyOrderToken(fabricated, SECRET)).toBeNull();
  });
});
