import { describe, expect, it } from "vitest";
import {
  computeWebhookSignature,
  getPaymentConfig,
  paymentsEnabled,
  verifyWebhook,
} from "../../src/services/paymentService.js";
import { ApiError } from "../../src/middleware/errorHandler.js";
import type { Bindings } from "../../src/types.js";

/**
 * Webhook verification is the only thing standing between a POST and free
 * food, so it is tested without a database: signature, freshness, and the
 * exact-bytes rule that the gateway's own sample code gets wrong.
 */

const SECRET = "whsec_test_secret_value_not_a_real_key";

/** A payload with keys deliberately NOT in alphabetical order, so any
 *  re-serialisation on the verify path would reorder them and change the
 *  bytes being signed. */
const RAW_BODY =
  '{"status":"success","order_id":"abc123","amount":150.50,"client_txn_id":"KLH1","event":"payment.success"}';

function nowSeconds(at: Date = new Date()): string {
  return String(Math.floor(at.getTime() / 1000));
}

describe("computeWebhookSignature", () => {
  it("signs timestamp + '.' + raw body with HMAC-SHA256, as lowercase hex", async () => {
    const sig = await computeWebhookSignature(SECRET, "1700000000", RAW_BODY);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", async () => {
    const a = await computeWebhookSignature(SECRET, "1700000000", RAW_BODY);
    const b = await computeWebhookSignature(SECRET, "1700000000", RAW_BODY);
    expect(a).toBe(b);
  });

  it("changes when the timestamp changes", async () => {
    const a = await computeWebhookSignature(SECRET, "1700000000", RAW_BODY);
    const b = await computeWebhookSignature(SECRET, "1700000001", RAW_BODY);
    expect(a).not.toBe(b);
  });

  it("changes when the secret changes", async () => {
    const a = await computeWebhookSignature(SECRET, "1700000000", RAW_BODY);
    const b = await computeWebhookSignature(`${SECRET}x`, "1700000000", RAW_BODY);
    expect(a).not.toBe(b);
  });

  /**
   * The reason the handler reads c.req.text() rather than c.req.json(). Byte
   * differences that JSON.parse/stringify would silently introduce — key
   * order, spacing — produce a different signature, so re-serialising before
   * verifying would reject every genuine webhook.
   */
  it("differs for a re-serialised body with the same meaning", async () => {
    const reserialised = JSON.stringify(JSON.parse(RAW_BODY));
    expect(reserialised).not.toBe(RAW_BODY);
    const fromRaw = await computeWebhookSignature(SECRET, "1700000000", RAW_BODY);
    const fromParsed = await computeWebhookSignature(SECRET, "1700000000", reserialised);
    expect(fromRaw).not.toBe(fromParsed);
  });
});

describe("verifyWebhook", () => {
  it("accepts a correctly signed, fresh delivery", async () => {
    const ts = nowSeconds();
    const signature = await computeWebhookSignature(SECRET, ts, RAW_BODY);
    const result = await verifyWebhook(SECRET, { signature, timestamp: ts }, RAW_BODY);
    expect(result.ok).toBe(true);
  });

  it("accepts an uppercase hex signature", async () => {
    const ts = nowSeconds();
    const signature = (await computeWebhookSignature(SECRET, ts, RAW_BODY)).toUpperCase();
    const result = await verifyWebhook(SECRET, { signature, timestamp: ts }, RAW_BODY);
    expect(result.ok).toBe(true);
  });

  it("rejects a body altered after signing", async () => {
    const ts = nowSeconds();
    const signature = await computeWebhookSignature(SECRET, ts, RAW_BODY);
    // The attack this exists to stop: same signature, larger amount.
    const tampered = RAW_BODY.replace("150.50", "1.00");
    const result = await verifyWebhook(SECRET, { signature, timestamp: ts }, tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature mismatch");
  });

  it("rejects a signature made with the wrong secret", async () => {
    const ts = nowSeconds();
    const signature = await computeWebhookSignature("whsec_wrong", ts, RAW_BODY);
    const result = await verifyWebhook(SECRET, { signature, timestamp: ts }, RAW_BODY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature mismatch");
  });

  it("rejects a missing signature header", async () => {
    const result = await verifyWebhook(SECRET, { timestamp: nowSeconds() }, RAW_BODY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing signature header");
  });

  it("rejects a missing timestamp header", async () => {
    const signature = await computeWebhookSignature(SECRET, nowSeconds(), RAW_BODY);
    const result = await verifyWebhook(SECRET, { signature }, RAW_BODY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing timestamp header");
  });

  it("rejects a non-numeric timestamp", async () => {
    const result = await verifyWebhook(
      SECRET,
      { signature: "a".repeat(64), timestamp: "not-a-number" },
      RAW_BODY,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("malformed timestamp header");
  });

  it("rejects a signature of the wrong length without throwing", async () => {
    const ts = nowSeconds();
    const result = await verifyWebhook(SECRET, { signature: "abc", timestamp: ts }, RAW_BODY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature mismatch");
  });

  /**
   * A signature never expires on its own, so without the timestamp bound a
   * single captured delivery could be replayed forever.
   */
  it("rejects a correctly signed but stale delivery", async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    const ts = nowSeconds(stale);
    const signature = await computeWebhookSignature(SECRET, ts, RAW_BODY);
    const result = await verifyWebhook(SECRET, { signature, timestamp: ts }, RAW_BODY);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/outside tolerance/);
  });

  it("rejects a timestamp far in the future", async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000);
    const ts = nowSeconds(future);
    const signature = await computeWebhookSignature(SECRET, ts, RAW_BODY);
    const result = await verifyWebhook(SECRET, { signature, timestamp: ts }, RAW_BODY);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/outside tolerance/);
  });

  it("accepts a delivery inside the tolerance window", async () => {
    const recent = new Date(Date.now() - 60 * 1000);
    const ts = nowSeconds(recent);
    const signature = await computeWebhookSignature(SECRET, ts, RAW_BODY);
    const result = await verifyWebhook(SECRET, { signature, timestamp: ts }, RAW_BODY);
    expect(result.ok).toBe(true);
  });
});

describe("paymentsEnabled", () => {
  const configured = {
    VYAPAR_API_KEY: "vg_live_x",
    VYAPAR_WEBHOOK_SECRET: SECRET,
    VYAPAR_CALLBACK_URL: "https://example.test/payments/webhook",
  } as unknown as Bindings;

  it("is off when the flag is absent", () => {
    expect(paymentsEnabled({ ...configured } as Bindings)).toBe(false);
  });

  it("is off when the flag is not 'true'", () => {
    expect(paymentsEnabled({ ...configured, PAYMENTS_ENABLED: "yes" } as Bindings)).toBe(false);
    expect(paymentsEnabled({ ...configured, PAYMENTS_ENABLED: "1" } as Bindings)).toBe(false);
    expect(paymentsEnabled({ ...configured, PAYMENTS_ENABLED: "false" } as Bindings)).toBe(false);
  });

  it("is on when the flag is 'true' in any case and credentials exist", () => {
    expect(paymentsEnabled({ ...configured, PAYMENTS_ENABLED: "true" } as Bindings)).toBe(true);
    expect(paymentsEnabled({ ...configured, PAYMENTS_ENABLED: "TRUE" } as Bindings)).toBe(true);
  });

  /** A half-configured deploy must read as off rather than presenting a
   *  checkout that can never settle. */
  it("is off when the flag is on but credentials are missing", () => {
    expect(paymentsEnabled({ PAYMENTS_ENABLED: "true" } as unknown as Bindings)).toBe(false);
    expect(
      paymentsEnabled({ PAYMENTS_ENABLED: "true", VYAPAR_API_KEY: "vg_live_x" } as unknown as Bindings),
    ).toBe(false);
  });
});

describe("getPaymentConfig", () => {
  it("returns the configured values", () => {
    const config = getPaymentConfig({
      VYAPAR_API_KEY: "vg_live_x",
      VYAPAR_WEBHOOK_SECRET: SECRET,
      VYAPAR_CALLBACK_URL: "https://example.test/payments/webhook",
      VYAPAR_REDIRECT_URL: "https://example.test/done",
    } as unknown as Bindings);
    expect(config.apiKey).toBe("vg_live_x");
    expect(config.webhookSecret).toBe(SECRET);
    expect(config.callbackUrl).toBe("https://example.test/payments/webhook");
    expect(config.redirectUrl).toBe("https://example.test/done");
  });

  it("throws a 503 naming the cause when the callback URL is missing", () => {
    expect(() =>
      getPaymentConfig({
        VYAPAR_API_KEY: "vg_live_x",
        VYAPAR_WEBHOOK_SECRET: SECRET,
      } as unknown as Bindings),
    ).toThrow(ApiError);
  });
});
