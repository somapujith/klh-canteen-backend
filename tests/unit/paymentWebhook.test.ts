import { describe, expect, it } from "vitest";
import { getPaymentConfig, paymentsEnabled } from "../../src/services/paymentService.js";
import { ApiError } from "../../src/middleware/errorHandler.js";
import type { Bindings } from "../../src/types.js";

/**
 * Payment configuration, tested without a database.
 *
 * GuruPay signs nothing on its webhook — no header, no shared secret — so
 * there is no signature-verification path to test here any more (see the
 * trust-model note atop paymentService.ts). What is asserted instead is that
 * a half-configured deploy reads as "off" rather than presenting a checkout
 * that can never settle. The real defence — confirming each settlement
 * against GuruPay's own check-status API — is exercised in
 * paymentSettlement.test.ts, because it needs a database.
 */

describe("paymentsEnabled", () => {
  const configured = {
    GURUPAY_API_KEY: "guru_test_not_real",
    GURUPAY_REDIRECT_URL: "https://example.test/payment/complete",
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
  });
});

describe("getPaymentConfig", () => {
  it("returns the configured values", () => {
    const config = getPaymentConfig({
      GURUPAY_API_KEY: "guru_test_not_real",
      GURUPAY_REDIRECT_URL: "https://example.test/payment/complete",
    } as unknown as Bindings);
    expect(config.apiKey).toBe("guru_test_not_real");
    expect(config.redirectUrl).toBe("https://example.test/payment/complete");
  });

  it("throws a 503 naming the cause when the redirect URL is missing", () => {
    expect(() =>
      getPaymentConfig({
        GURUPAY_API_KEY: "guru_test_not_real",
      } as unknown as Bindings),
    ).toThrow(ApiError);
  });

  it("throws a 503 naming the cause when the API key is missing", () => {
    expect(() =>
      getPaymentConfig({
        GURUPAY_REDIRECT_URL: "https://example.test/payment/complete",
      } as unknown as Bindings),
    ).toThrow(ApiError);
  });
});
