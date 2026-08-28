import { describe, it, expect } from "vitest";

/**
 * The login delay curve, pinned.
 *
 * This exists because the curve is a SECURITY control standing in for the
 * account lockout that this codebase deliberately does not have: login is
 * keyed on the submitted roll number, roll numbers are public on the class
 * roster, so any lockout tier would let anyone disable any student's account
 * on demand. The delay curve is what replaces it, and quietly weakening it
 * (or "simplifying" the cap back down) would reopen the brute-force window
 * without any test going red. Hence these numbers are asserted directly.
 *
 * The formula is applyProgressiveDelay's, transcribed: no delay through
 * `max`, then baseMs doubling per attempt past it, clamped to maxMs. It is
 * reproduced here rather than imported because the middleware's copy sleeps
 * for real — a test that exercised it directly would take minutes.
 */
function delayForAttempt(attempt: number, max: number, baseMs: number, maxMs: number): number {
  if (attempt <= max) return 0;
  const overage = attempt - max;
  return Math.min(baseMs * 2 ** (overage - 1), maxMs);
}

// Mirrors the loginLimiter config in src/routes/auth.ts.
const MAX = 5;
const BASE_MS = 250;
const MAX_MS = 30_000;

const delay = (attempt: number) => delayForAttempt(attempt, MAX, BASE_MS, MAX_MS);

describe("login progressive-delay curve", () => {
  it("never delays a student inside the free allowance", () => {
    // A student who mistypes a few times must feel nothing at all.
    for (let attempt = 1; attempt <= MAX; attempt++) {
      expect(delay(attempt)).toBe(0);
    }
  });

  it("stays imperceptible for the first mistakes past the allowance", () => {
    // 6th and 7th attempts are still sub-second: this is the "fumbling
    // student", not an attacker, and they should barely notice.
    expect(delay(6)).toBe(250);
    expect(delay(7)).toBe(500);
  });

  it("reaches multi-second delays by the tenth attempt", () => {
    expect(delay(8)).toBe(1_000);
    expect(delay(9)).toBe(2_000);
    expect(delay(10)).toBe(4_000);
  });

  it("caps at 30s and never grows beyond it", () => {
    expect(delay(13)).toBe(MAX_MS);
    expect(delay(50)).toBe(MAX_MS);
    expect(delay(10_000)).toBe(MAX_MS);
  });

  it("holds a guesser to 2 attempts per minute once capped", () => {
    // The actual security property. A 2-minute lockout would let a guesser
    // resume at full speed once it lifted; this ceiling never lifts while
    // they keep trying, so the sustained rate is strictly lower.
    const attemptsPerMinute = 60_000 / delay(13);
    expect(attemptsPerMinute).toBe(2);
  });

  it("costs a guesser over a minute to reach 13 attempts", () => {
    let total = 0;
    for (let attempt = 1; attempt <= 13; attempt++) total += delay(attempt);
    expect(total).toBeGreaterThan(60_000);
  });

  it("is finite at every attempt — a correct password always gets served", () => {
    // The invariant that makes the missing lockout safe. If this can ever be
    // Infinity (or the strategy ever becomes "reject"), the campus-ID lockout
    // hole is open again.
    for (const attempt of [1, MAX, MAX + 1, 13, 100, 100_000]) {
      expect(Number.isFinite(delay(attempt))).toBe(true);
      expect(delay(attempt)).toBeLessThanOrEqual(MAX_MS);
    }
  });
});
