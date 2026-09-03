import { describe, expect, it } from "vitest";
import { getPaymentConfig, paymentsEnabled, verifyWebhook } from "../../src/services/paymentService.js";
import { ApiError } from "../../src/middleware/errorHandler.js";
import type { Bindings } from "../../src/types.js";

/**
 * Webhook authentication, tested without a database.
 *
 * SafeUPI does not sign its webhooks — it echoes a shared secret in the body —
 * so what is asserted here is narrower than a signature check would allow:
 * that the right secret is accepted, that every wrong or missing one is
 * refused, and that a misconfigured deploy refuses everything rather than
 * accepting everything. The rest of the defence (confirming each settlement
 * against SafeUPI's own Status API) is exercised in paymentSettlement.test.ts,
 * because it needs a database.
 */

const WEBHOOK_SECRET = "whsec_test_secret_not_real_do_not_use";

describe("verifyWebhook", () => {
  it("accepts the configured secret", () => {
    expect(verifyWebhook(WEBHOOK_SECRET, WEBHOOK_SECRET).ok).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const result = verifyWebhook(WEBHOOK_SECRET, "whsec_attacker_guessed_this");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("secret mismatch");
  });

  it("rejects a secret that is merely a prefix of the real one", () => {
    const result = verifyWebhook(WEBHOOK_SECRET, WEBHOOK_SECRET.slice(0, -1));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("secret mismatch");
  });

  it("rejects a missing secret", () => {
    expect(verifyWebhook(WEBHOOK_SECRET, undefined).ok).toBe(false);
    expect(verifyWebhook(WEBHOOK_SECRET, "").reason).toBe("missing secret in payload");
  });

  it("rejects a non-string secret", () => {
    // A JSON body can carry any type here, and `{secret: true}` must not slip
    // through some truthiness check.
    expect(verifyWebhook(WEBHOOK_SECRET, true as unknown).ok).toBe(false);
    expect(verifyWebhook(WEBHOOK_SECRET, 12345 as unknown).ok).toBe(false);
    expect(verifyWebhook(WEBHOOK_SECRET, { secret: WEBHOOK_SECRET } as unknown).ok).toBe(false);
  });

  /**
   * The failure mode this guards against: with no configured secret, an empty
   * supplied one would compare equal and every POST would authenticate.
   */
  it("refuses everything when no secret is configured", () => {
    expect(verifyWebhook("", "").ok).toBe(false);
    expect(verifyWebhook("", "anything").ok).toBe(false);
    expect(verifyWebhook("", "").reason).toBe("no webhook secret configured");
  });
});

describe("paymentsEnabled", () => {
  const configured = {
    SAFEUPI_API_SECRET: "sk_test_not_real",
    SAFEUPI_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SAFEUPI_REDIRECT_URL: "https://example.test/payment/complete",
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
      paymentsEnabled({
        PAYMENTS_ENABLED: "true",
        SAFEUPI_API_SECRET: "sk_test_not_real",
      } as unknown as Bindings),
    ).toBe(false);
  });
});

describe("getPaymentConfig", () => {
  it("returns the configured values", () => {
    const config = getPaymentConfig({
      SAFEUPI_API_SECRET: "sk_test_not_real",
      SAFEUPI_WEBHOOK_SECRET: WEBHOOK_SECRET,
      SAFEUPI_REDIRECT_URL: "https://example.test/payment/complete",
      SAFEUPI_MERCHANT_ID: "12",
    } as unknown as Bindings);
    expect(config.apiSecret).toBe("sk_test_not_real");
    expect(config.webhookSecret).toBe(WEBHOOK_SECRET);
    expect(config.redirectUrl).toBe("https://example.test/payment/complete");
    expect(config.merchantId).toBe("12");
  });

  it("throws a 503 naming the cause when the redirect URL is missing", () => {
    expect(() =>
      getPaymentConfig({
        SAFEUPI_API_SECRET: "sk_test_not_real",
        SAFEUPI_WEBHOOK_SECRET: WEBHOOK_SECRET,
      } as unknown as Bindings),
    ).toThrow(ApiError);
  });

  /** The webhook secret is required, not optional: without it the bearer check
   *  degenerates into accepting every POST. */
  it("throws when the webhook secret is missing", () => {
    expect(() =>
      getPaymentConfig({
        SAFEUPI_API_SECRET: "sk_test_not_real",
        SAFEUPI_REDIRECT_URL: "https://example.test/payment/complete",
      } as unknown as Bindings),
    ).toThrow(ApiError);
  });
});
