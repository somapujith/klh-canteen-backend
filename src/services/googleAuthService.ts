/**
 * "Sign in with Google" for DRK students. DRK has no seeded roster (unlike
 * KLH's bulk-imported cohort) and no demo account, so the first Google
 * sign-in auto-creates the STUDENT row rather than requiring pre-provisioning.
 *
 * The ID token is verified against Google's tokeninfo endpoint over `fetch`
 * (same raw-fetch-to-provider pattern telegramService.ts already uses) rather
 * than the `google-auth-library` SDK, which is Node-oriented and awkward on
 * Workers.
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Pool } from "@neondatabase/serverless";
import { sql } from "../db/sql.js";
import * as userRepo from "../db/userRepo.js";
import { isUniqueViolation } from "../db/errors.js";
import { ApiError } from "../middleware/errorHandler.js";
import { signToken } from "../lib/jwt.js";
import { assertPasswordStrength } from "./passwordPolicy.js";

/** Matches authService.ts's BCRYPT_COST — kept local since a Google-only
 *  account's hash is generated once and never compared against a typed
 *  password, so there is no shared migration concern to couple the two. */
const BCRYPT_COST = 10;

interface GoogleTokenInfo {
  sub: string;
  email?: string;
  email_verified?: string;
  aud: string;
  name?: string;
}

async function verifyGoogleIdToken(idToken: string, clientId: string): Promise<GoogleTokenInfo> {
  let res: Response;
  try {
    res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
    );
  } catch {
    throw new ApiError(503, "GOOGLE_UNREACHABLE", "Could not reach Google to verify sign-in. Try again.");
  }
  if (!res.ok) {
    throw new ApiError(401, "INVALID_GOOGLE_TOKEN", "Invalid or expired Google sign-in. Please try again.");
  }

  const info = (await res.json()) as GoogleTokenInfo;
  if (info.aud !== clientId) {
    throw new ApiError(401, "INVALID_GOOGLE_TOKEN", "Invalid Google sign-in.");
  }
  if (info.email_verified !== "true" || !info.email) {
    throw new ApiError(403, "EMAIL_NOT_VERIFIED", "Your Google account's email is not verified.");
  }
  return info;
}

export interface GoogleLoginResult {
  token: string;
  role: "STUDENT";
  name: string;
  kitchen: string | null;
  id: string;
  school: "DRK";
  mustChangePassword: false;
}

/**
 * DRK-students-only. Finds by googleId first (the stable identity key), then
 * falls back to linking an existing DRK student row with a matching verified
 * email, then creates a new one. Rejects outright for KLH — this sign-in
 * method does not exist for that school.
 */
export async function loginWithGoogle(
  pool: Pool,
  jwtSecret: string,
  googleClientId: string,
  idToken: string
): Promise<GoogleLoginResult> {
  const info = await verifyGoogleIdToken(idToken, googleClientId);
  const email = info.email!;

  let user = await userRepo.findByGoogleId(pool, info.sub);

  if (!user) {
    const existing = await userRepo.findFirstByEmailOrRollNumber(pool, email, { role: "STUDENT" });
    if (existing) {
      if (existing.school !== "DRK") {
        throw new ApiError(403, "FORBIDDEN", "Google sign-in is only available for DRK students.");
      }
      user = await userRepo.updateFields(
        pool,
        existing.id,
        sql`"googleId" = ${info.sub}, "googleEmail" = ${email}`
      );
    } else {
      // No password will ever be compared against this hash — it exists only
      // because the column is NOT NULL. A random value, not a guessable
      // constant, so it can never coincide with anything a real user picks.
      const passwordHash = await bcrypt.hash(crypto.randomUUID(), BCRYPT_COST);
      const created = await userRepo.insert(pool, {
        role: "STUDENT",
        name: info.name?.trim() || email,
        email,
        passwordHash,
        school: "DRK",
        mustChangePassword: false,
        googleId: info.sub,
        googleEmail: email,
      });
      user = created;
    }
  }

  if (user.school !== "DRK") {
    throw new ApiError(403, "FORBIDDEN", "Google sign-in is only available for DRK students.");
  }
  if (user.role !== "STUDENT") {
    throw new ApiError(403, "FORBIDDEN", "Google sign-in is only available for students.");
  }
  if (!user.isActive) {
    throw new ApiError(403, "ACCOUNT_DEACTIVATED", "This account has been deactivated. Contact the canteen office.");
  }

  const token = signToken({ sub: user.id, role: user.role, kitchen: user.kitchen }, jwtSecret);
  return {
    token,
    role: "STUDENT",
    name: user.name,
    kitchen: user.kitchen,
    id: user.id,
    school: "DRK",
    mustChangePassword: false,
  };
}

// ---------------------------------------------------------------------------
// KLH students — two-phase flow
//
// Any verified Google account may start this flow (no klh.edu.in domain
// requirement — this uses the same GOOGLE_CLIENT_ID_GUEST client as guest
// sign-in, not a KLH-institutional one). Because the Google identity carries
// no roll number to infer anything from, the account is always brand new:
// the student picks their own username and password on the setup screen,
// and that becomes their login going forward (username+password OR Google).
// ---------------------------------------------------------------------------

/** Distinct `aud` so this ticket can never be presented to a normal
 *  auth-required endpoint — verifyToken()'s callers never check `aud`, so a
 *  reused JWT_SECRET alone would not stop that. */
const SETUP_TOKEN_AUD = "google-klh-setup";
const SETUP_TOKEN_TTL = "5m";

interface SetupTokenPayload {
  googleId: string;
  googleEmail: string;
  aud: typeof SETUP_TOKEN_AUD;
}

function signSetupToken(jwtSecret: string, googleId: string, googleEmail: string): string {
  const payload: SetupTokenPayload = { googleId, googleEmail, aud: SETUP_TOKEN_AUD };
  return jwt.sign(payload, jwtSecret, { expiresIn: SETUP_TOKEN_TTL });
}

function verifySetupToken(jwtSecret: string, setupToken: string): SetupTokenPayload {
  let payload: SetupTokenPayload;
  try {
    payload = jwt.verify(setupToken, jwtSecret) as SetupTokenPayload;
  } catch {
    throw new ApiError(401, "SETUP_EXPIRED", "This sign-in has expired. Please try again with Google.");
  }
  if (payload.aud !== SETUP_TOKEN_AUD || !payload.googleId || !payload.googleEmail) {
    throw new ApiError(401, "INVALID_SETUP_TOKEN", "Invalid sign-in session.");
  }
  return payload;
}

export interface GoogleKlhStartResult {
  setupToken: string;
  /** The Google account's own local-part, offered as a starting point only —
   *  always editable, never treated as a roll number. */
  suggestedUsername: string;
}

export async function startGoogleKlhLogin(
  jwtSecret: string,
  googleClientId: string,
  idToken: string
): Promise<GoogleKlhStartResult> {
  const info = await verifyGoogleIdToken(idToken, googleClientId);
  const email = info.email!;
  const localPart = email.split("@")[0];

  return {
    setupToken: signSetupToken(jwtSecret, info.sub, email),
    suggestedUsername: localPart,
  };
}

export interface GoogleKlhCompleteResult {
  token: string;
  role: "STUDENT";
  name: string;
  kitchen: string | null;
  id: string;
  school: "KLH";
  mustChangePassword: false;
}

export async function completeGoogleKlhLogin(
  pool: Pool,
  jwtSecret: string,
  setupToken: string,
  username: string,
  password: string
): Promise<GoogleKlhCompleteResult> {
  const { googleId, googleEmail } = verifySetupToken(jwtSecret, setupToken);

  const trimmedUsername = username.trim();
  if (!trimmedUsername) {
    throw new ApiError(400, "MISSING_USERNAME", "Username is required.");
  }
  assertPasswordStrength(password, { email: googleEmail });

  const passwordHash = await bcrypt.hash(password, 10);

  // Always a fresh account — no domain-derived roll number to match an
  // existing roster row against, and no attempt to link one. A student who
  // already has an account uses that account's own username+password to
  // log in; this flow is only ever "create a new one".
  let user;
  try {
    user = await userRepo.insert(pool, {
      role: "STUDENT",
      name: trimmedUsername,
      email: trimmedUsername,
      passwordHash,
      school: "KLH",
      mustChangePassword: false,
      googleId,
      googleEmail,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Two distinct causes share 23505 here: the username (User_email_key)
      // or this Google account having already completed setup once before
      // (User_googleId_key, e.g. a double-submitted request). The username
      // message is right far more often, and either way the fix from the
      // student's side is the same — try again.
      throw new ApiError(409, "USERNAME_TAKEN", "That username was just taken. Please try again.");
    }
    throw err;
  }

  const token = signToken({ sub: user.id, role: user.role, kitchen: user.kitchen }, jwtSecret);
  return {
    token,
    role: "STUDENT",
    name: user.name,
    kitchen: user.kitchen,
    id: user.id,
    school: "KLH",
    mustChangePassword: false,
  };
}
