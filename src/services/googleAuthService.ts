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
// KLH's User.email holds the bare roll number (studentRosterService.ts), not
// a real address, so a Google email can never match it the way DRK's
// find-by-email fallback does. Instead: verify the klh.edu.in Google
// identity, derive a candidate username from it, and hand the client a
// short-lived setup ticket. The account (new or existing) is only written
// once the student has confirmed/typed a username and set a password —
// unconditionally, every first-time Google sign-in, per product spec.
// ---------------------------------------------------------------------------

const KLH_EMAIL_DOMAIN = "klh.edu.in";
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

/** The digit run at the start of a roll-number-style local-part, or null for
 *  a name-based address (e.g. "priya.rao@klh.edu.in"). */
function extractRollNumber(localPart: string): string | null {
  const match = localPart.match(/^\d+/);
  return match ? match[0] : null;
}

export interface GoogleKlhStartResult {
  setupToken: string;
  suggestedUsername: string;
  usernameEditable: boolean;
  accountExists: boolean;
}

export async function startGoogleKlhLogin(
  pool: Pool,
  jwtSecret: string,
  googleClientId: string,
  idToken: string
): Promise<GoogleKlhStartResult> {
  const info = await verifyGoogleIdToken(idToken, googleClientId);
  const email = info.email!;
  const [localPart, domain] = email.split("@");

  if (domain?.toLowerCase() !== KLH_EMAIL_DOMAIN) {
    throw new ApiError(
      403,
      "INVALID_DOMAIN",
      `Google sign-in for KLH requires a ${KLH_EMAIL_DOMAIN} account.`
    );
  }

  const rollNumber = extractRollNumber(localPart);
  const suggestedUsername = rollNumber ?? localPart;
  const usernameEditable = rollNumber === null;

  const existing = await userRepo.findFirstByEmailOrRollNumber(pool, suggestedUsername, {
    role: "STUDENT",
  });

  return {
    setupToken: signSetupToken(jwtSecret, info.sub, email),
    suggestedUsername,
    usernameEditable,
    accountExists: existing !== null && existing.school === "KLH",
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
  assertPasswordStrength(password, { rollNumber: trimmedUsername, email: googleEmail });

  const passwordHash = await bcrypt.hash(password, 10);
  const localPart = googleEmail.split("@")[0];
  const derivedRollNumber = extractRollNumber(localPart);
  // The username only becomes rollNumber when it still matches the digits
  // Google's email actually carried — if the student edited a numeric
  // suggestion into something else, or typed a free-text handle for a
  // name-based address, it stays a login-only username.
  const rollNumberForInsert = derivedRollNumber === trimmedUsername ? derivedRollNumber : null;

  const existing = await userRepo.findFirstByEmailOrRollNumber(pool, trimmedUsername, {
    role: "STUDENT",
  });

  let user;
  if (existing) {
    if (existing.school !== "KLH") {
      throw new ApiError(403, "FORBIDDEN", "This username belongs to a different institution.");
    }
    user = await userRepo.updateFields(
      pool,
      existing.id,
      sql`"passwordHash" = ${passwordHash}, "googleId" = ${googleId}, "googleEmail" = ${googleEmail}, "mustChangePassword" = ${false}`
    );
  } else {
    try {
      user = await userRepo.insert(pool, {
        role: "STUDENT",
        name: trimmedUsername,
        email: trimmedUsername,
        passwordHash,
        rollNumber: rollNumberForInsert,
        school: "KLH",
        mustChangePassword: false,
        googleId,
        googleEmail,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiError(409, "USERNAME_TAKEN", "That username was just taken. Please try again.");
      }
      throw err;
    }
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
    school: "KLH",
    mustChangePassword: false,
  };
}
