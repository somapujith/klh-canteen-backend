import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  googleGuestSessionId,
  issueGuestSessionForId,
  issueGuestSession,
  verifyGuestSession,
  guestSubjectId,
} from "../../src/services/guestSessionService.js";
import { loginGuestWithGoogle } from "../../src/services/googleGuestService.js";

const SECRET = "test-qr-secret";
const GUEST_CLIENT = "guest-client.apps.googleusercontent.com";
const STUDENT_CLIENT = "student-client.apps.googleusercontent.com";

function googleResponse(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({
      sub: "108347affe2910",
      email: "2300031234@klh.edu.in",
      email_verified: "true",
      aud: GUEST_CLIENT,
      name: "Test Guest",
      ...over,
    }),
  } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("googleGuestSessionId", () => {
  it("is stable for the same Google subject — the whole point of the feature", () => {
    // A guest who clears their cache or switches device must land on the same
    // session id, or their pending order becomes unreachable again.
    const a = googleGuestSessionId("sub-123", SECRET);
    const b = googleGuestSessionId("sub-123", SECRET);
    expect(a).toBe(b);
  });

  it("differs per Google subject, so one guest cannot read another's orders", () => {
    expect(googleGuestSessionId("sub-123", SECRET)).not.toBe(googleGuestSessionId("sub-456", SECRET));
  });

  it("does not leak the raw Google subject into the id", () => {
    // The id is written to Order.guestSessionId and broadcast as a realtime
    // subject, so a raw `sub` there would be spreading a stable cross-service
    // identifier through rows and frames.
    const id = googleGuestSessionId("108347affe2910", SECRET);
    expect(id).not.toContain("108347affe2910");
  });

  it("is keyed to the secret, so the mapping cannot be recomputed from a sub alone", () => {
    expect(googleGuestSessionId("sub-123", SECRET)).not.toBe(googleGuestSessionId("sub-123", "other-secret"));
  });

  it("contains no dot, which would corrupt the 4-part token format", () => {
    // issueGuestSessionForId packs `prefix.sessionId.issuedAt.sig` and the
    // verifier splits on "." expecting exactly 4 parts.
    expect(googleGuestSessionId("sub-123", SECRET)).not.toContain(".");
  });

  it("cannot collide with an anonymous session id", () => {
    // Anonymous ids are crypto.randomUUID(); derived ones carry a "g:" prefix
    // that a UUID can never produce.
    const derived = googleGuestSessionId("sub-123", SECRET);
    expect(derived.startsWith("g:")).toBe(true);
    expect(issueGuestSession(SECRET).sessionId.startsWith("g:")).toBe(false);
  });
});

describe("issueGuestSessionForId", () => {
  it("round-trips through verifyGuestSession", () => {
    const id = googleGuestSessionId("sub-123", SECRET);
    const session = issueGuestSessionForId(id, SECRET);
    expect(verifyGuestSession(session.token, SECRET)).toBe(id);
  });

  it("issues distinct tokens over the SAME id, and both read the same orders", () => {
    // Signing in twice (two devices, or after an expiry) must not fork the
    // guest into two order histories.
    const id = googleGuestSessionId("sub-123", SECRET);
    const first = issueGuestSessionForId(id, SECRET);
    const second = issueGuestSessionForId(id, SECRET);
    expect(verifyGuestSession(first.token, SECRET)).toBe(verifyGuestSession(second.token, SECRET));
  });

  it("produces a token that a wrong secret cannot verify", () => {
    const session = issueGuestSessionForId(googleGuestSessionId("sub-123", SECRET), SECRET);
    expect(verifyGuestSession(session.token, "wrong-secret")).toBeNull();
  });

  it("stays inside the guest realtime namespace", () => {
    const id = googleGuestSessionId("sub-123", SECRET);
    expect(guestSubjectId(id).startsWith("guest:")).toBe(true);
  });
});

describe("loginGuestWithGoogle", () => {
  it("issues a guest session for a verified klh.edu.in account", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => googleResponse()));
    const result = await loginGuestWithGoogle(GUEST_CLIENT, SECRET, "id-token");

    expect(result.email).toBe("2300031234@klh.edu.in");
    expect(verifyGuestSession(result.sessionToken, SECRET)).toBe(
      googleGuestSessionId("108347affe2910", SECRET)
    );
  });

  it("REFUSES a token minted for the student client", async () => {
    // The audience boundary. Separate OAuth clients only buy isolation if the
    // `aud` is actually checked against THIS flow's client id — otherwise a
    // student's token would mint a guest session and vice versa.
    vi.stubGlobal("fetch", vi.fn(async () => googleResponse({ aud: STUDENT_CLIENT })));
    await expect(loginGuestWithGoogle(GUEST_CLIENT, SECRET, "id-token")).rejects.toMatchObject({
      status: 401,
      code: "INVALID_GOOGLE_TOKEN",
    });
  });

  it("refuses a non-klh.edu.in address", async () => {
    // Otherwise anyone on the internet could mint a durable session, which is
    // no better than the anonymous one it replaces.
    vi.stubGlobal("fetch", vi.fn(async () => googleResponse({ email: "someone@gmail.com" })));
    await expect(loginGuestWithGoogle(GUEST_CLIENT, SECRET, "id-token")).rejects.toMatchObject({
      status: 403,
      code: "INVALID_DOMAIN",
    });
  });

  it("refuses an unverified email", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => googleResponse({ email_verified: "false" })));
    await expect(loginGuestWithGoogle(GUEST_CLIENT, SECRET, "id-token")).rejects.toMatchObject({
      status: 403,
      code: "EMAIL_NOT_VERIFIED",
    });
  });

  it("refuses a token Google itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false }) as Response));
    await expect(loginGuestWithGoogle(GUEST_CLIENT, SECRET, "id-token")).rejects.toMatchObject({
      status: 401,
      code: "INVALID_GOOGLE_TOKEN",
    });
  });

  it("surfaces a reachability failure as 503 rather than a bad token", async () => {
    // A network blip must not read to the guest as "your account is invalid".
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    await expect(loginGuestWithGoogle(GUEST_CLIENT, SECRET, "id-token")).rejects.toMatchObject({
      status: 503,
      code: "GOOGLE_UNREACHABLE",
    });
  });

  it("returns the same session id on a second sign-in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => googleResponse()));
    const first = await loginGuestWithGoogle(GUEST_CLIENT, SECRET, "token-a");
    const second = await loginGuestWithGoogle(GUEST_CLIENT, SECRET, "token-b");

    expect(verifyGuestSession(first.sessionToken, SECRET)).toBe(
      verifyGuestSession(second.sessionToken, SECRET)
    );
  });
});
