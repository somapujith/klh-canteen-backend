/**
 * "Sign in with Google" for KLH walk-up guests.
 *
 * WHY THIS EXISTS
 * An anonymous guest session is a random UUID held only in the browser, so a
 * guest who cleared their cache, switched devices, or opened a private window
 * lost the only key that could read their pending order back. The order was
 * still real and still cooking; it had simply become unreachable. Signing in
 * with Google gives the session a STABLE id derived from the Google subject,
 * so the same person recovers the same tickets anywhere.
 *
 * WHY IT IS NOT AN ACCOUNT
 * No User row is created. A guest who signs in is still a guest: they get a
 * guest session token, their orders still land in Order.guestSessionId, and
 * they still cannot reach a single student or admin endpoint. The Google
 * identity is used for exactly one thing — deriving a session id that is the
 * same on every sign-in — and is never persisted. That keeps the guest
 * security model in guest.ts intact (ownership is a predicate on the session
 * id, nothing more) and means this flow grants no privilege whatsoever.
 *
 * WHY A SEPARATE CLIENT ID FROM THE STUDENT FLOW
 * GOOGLE_CLIENT_ID_GUEST is a different OAuth client from
 * GOOGLE_CLIENT_ID_KLH, and verification checks `aud` against the one for
 * THIS flow. That is what stops a token minted for the student button from
 * being replayed here (or the reverse) — the audience check is the boundary,
 * so the two flows cannot be crossed even though both accept klh.edu.in
 * addresses.
 */
import { ApiError } from "../middleware/errorHandler.js";
import { googleGuestSessionId, issueGuestSessionForId } from "./guestSessionService.js";

/**
 * Guests must hold a klh.edu.in address, matching the student flow's rule.
 * This is what makes the sign-in meaningful — a personal Gmail would let
 * anyone on the internet mint a durable session, which is no better than the
 * anonymous one it replaces.
 */
const KLH_EMAIL_DOMAIN = "klh.edu.in";

interface GoogleTokenInfo {
  sub: string;
  email?: string;
  email_verified?: string;
  aud: string;
  name?: string;
}

/**
 * Verifies an ID token against Google, for THIS flow's audience.
 *
 * Deliberately a local copy of the same tokeninfo call the student service
 * makes, rather than an import: the two flows have different client IDs and
 * different failure semantics, and sharing the helper would invite a future
 * edit to make one client id serve both — which is precisely the audience
 * confusion the separate clients exist to prevent.
 */
async function verifyGuestGoogleIdToken(idToken: string, clientId: string): Promise<GoogleTokenInfo> {
  let res: Response;
  try {
    res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  } catch {
    throw new ApiError(503, "GOOGLE_UNREACHABLE", "Could not reach Google to verify sign-in. Try again.");
  }
  if (!res.ok) {
    throw new ApiError(401, "INVALID_GOOGLE_TOKEN", "Invalid or expired Google sign-in. Please try again.");
  }

  const info = (await res.json()) as GoogleTokenInfo;

  // The audience boundary. A token minted for the student client must not be
  // usable here, so this is checked before anything else is trusted.
  if (info.aud !== clientId) {
    throw new ApiError(401, "INVALID_GOOGLE_TOKEN", "Invalid Google sign-in.");
  }
  if (info.email_verified !== "true" || !info.email) {
    throw new ApiError(403, "EMAIL_NOT_VERIFIED", "Your Google account's email is not verified.");
  }
  if (!info.sub) {
    throw new ApiError(401, "INVALID_GOOGLE_TOKEN", "Invalid Google sign-in.");
  }
  return info;
}

export interface GoogleGuestSessionResult {
  sessionToken: string;
  expiresAt: string;
  expiresInSeconds: number;
  /** Shown at the counter so the guest can see which account they are on. */
  email: string;
  name: string | null;
}

/**
 * Exchanges a verified Google ID token for a guest session whose id is stable
 * for this Google account.
 *
 * Idempotent by construction: called twice for the same account it returns a
 * different token (a fresh issuedAt) over the SAME session id, so both tokens
 * read exactly the same orders. That is the whole feature — the ticket is
 * recoverable rather than tied to one browser.
 */
export async function loginGuestWithGoogle(
  googleClientId: string,
  qrTokenSecret: string,
  idToken: string
): Promise<GoogleGuestSessionResult> {
  const info = await verifyGuestGoogleIdToken(idToken, googleClientId);
  const email = info.email!;
  const domain = email.split("@")[1];

  if (domain?.toLowerCase() !== KLH_EMAIL_DOMAIN) {
    throw new ApiError(
      403,
      "INVALID_DOMAIN",
      `Guest sign-in requires a ${KLH_EMAIL_DOMAIN} account.`
    );
  }

  const sessionId = googleGuestSessionId(info.sub, qrTokenSecret);
  const session = issueGuestSessionForId(sessionId, qrTokenSecret);

  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    expiresInSeconds: session.expiresInSeconds,
    email,
    name: info.name ?? null,
  };
}
