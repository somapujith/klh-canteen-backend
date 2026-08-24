import crypto from "node:crypto";

/**
 * Opaque, stateless guest sessions.
 *
 * A walk-up guest has no account, so there is nothing to authenticate them
 * against. What they get instead is a signed bearer of a random session id:
 * an HMAC over `<prefix>.<sessionId>.<issuedAt>`, built exactly like
 * lib/orderToken.ts and signed with the same QR_TOKEN_SECRET.
 *
 * Why an HMAC rather than a random string in a table:
 *   - it is unforgeable without the secret, so `sessionId` can be trusted as
 *     an ownership key the moment it verifies — no DB round-trip, no session
 *     table to grow and sweep;
 *   - it carries its own expiry, so an abandoned counter tablet cannot read
 *     yesterday's orders.
 *
 * What this is NOT: authentication or identity. It proves only "the caller
 * holds the session that placed these orders". Every guest read MUST still
 * scope its query by the recovered sessionId — the token grants access to
 * that session's rows and to nothing else. See guest.ts.
 */

const MAGIC_PREFIX = "KLHG1";

/**
 * Deliberately short. A guest session exists to cover one visit: order, wait,
 * collect. Anything longer is a token sitting on an unattended phone with no
 * password behind it and no way for the owner to revoke it.
 */
export const GUEST_SESSION_TTL_SECONDS = 4 * 60 * 60; // 4h

function sign(sessionId: string, issuedAt: number, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${MAGIC_PREFIX}.${sessionId}.${issuedAt}`)
    .digest("base64url");
}

export interface GuestSession {
  token: string;
  sessionId: string;
  expiresAt: string;
  expiresInSeconds: number;
}

export function issueGuestSession(secret: string): GuestSession {
  if (!secret) throw new Error("QR_TOKEN_SECRET not set");
  const sessionId = crypto.randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  const sig = sign(sessionId, issuedAt, secret);
  const payload = `${MAGIC_PREFIX}.${sessionId}.${issuedAt}.${sig}`;
  return {
    token: Buffer.from(payload).toString("base64url"),
    sessionId,
    expiresAt: new Date((issuedAt + GUEST_SESSION_TTL_SECONDS) * 1000).toISOString(),
    expiresInSeconds: GUEST_SESSION_TTL_SECONDS,
  };
}

/** Returns the session id, or null for anything malformed, expired or forged. */
export function verifyGuestSession(token: string, secret: string): string | null {
  try {
    if (!secret) throw new Error("QR_TOKEN_SECRET not set");
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(".");
    if (parts.length !== 4) return null;
    const [prefix, sessionId, issuedAtStr, sig] = parts;

    // The prefix keeps guest sessions and order tokens in separate
    // namespaces even though they share a secret: an order token can never
    // be replayed as a session, or vice versa.
    if (prefix !== MAGIC_PREFIX) return null;

    const issuedAt = Number(issuedAtStr);
    if (!Number.isFinite(issuedAt)) return null;
    const ageSeconds = Math.floor(Date.now() / 1000) - issuedAt;
    if (ageSeconds < 0 || ageSeconds > GUEST_SESSION_TTL_SECONDS) return null;

    const expectedSig = sign(sessionId, issuedAt, secret);
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    return sessionId;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Realtime subject namespacing
// ---------------------------------------------------------------------------

/**
 * Prefix that separates guest sessions from accounts in the realtime hub's
 * SUBJECT address space.
 *
 * The hub routes personal frames by exact string equality on a subject id
 * (`matches()` in durableObjects/orderEventsHub.ts, and the `s:<subjectId>`
 * WebSocket tag). Students and admins are addressed by their User.id — a
 * Prisma UUID, which is 36 characters of hex and dashes and can therefore
 * never contain a colon. Prefixing guests with `guest:` puts them in a
 * disjoint region of that address space, so:
 *
 *   - a guest session id can never equal a student id, even if an attacker
 *     could somehow choose it (they cannot: it is a server-side randomUUID
 *     read back out of a verified HMAC, never accepted as a parameter);
 *   - a student id can never be spelled as a guest subject, so a compromised
 *     account cannot subscribe to a guest's frames either.
 *
 * The prefix is applied at exactly two places — where a guest connection is
 * subscribed (routes/events.ts) and where a guest order's status change is
 * emitted — and nowhere else, so the two can never drift apart.
 */
export const GUEST_SUBJECT_PREFIX = "guest:";

/** Realtime subject id for a verified guest session. */
export function guestSubjectId(sessionId: string): string {
  return `${GUEST_SUBJECT_PREFIX}${sessionId}`;
}

/**
 * Same, but null-safe, for call sites holding `Order.guestSessionId` — which
 * is null on every student order. Returning null there means "no personal
 * push", which is exactly what `emitOrderStatusChanged` already does with a
 * null subject.
 */
export function guestSubjectIdOrNull(sessionId: string | null | undefined): string | null {
  return sessionId ? guestSubjectId(sessionId) : null;
}

/** True for a subject id minted by `guestSubjectId`. */
export function isGuestSubjectId(subjectId: string): boolean {
  return subjectId.startsWith(GUEST_SUBJECT_PREFIX);
}
