import { ApiError } from "../middleware/errorHandler.js";

/**
 * Minimum bar for a password a student chooses for themselves.
 *
 * Deliberately modest. The threat this codebase is actually defending against
 * is not a GPU cracking a bcrypt hash — it is a classmate reading a roll
 * number off the public class roster and typing the one password everybody was
 * issued. So the rules that matter are the ones that stop a "new" password
 * from being guessable *from public information about that student*: the
 * shared default, their roll number, their email, and the handful of strings
 * every shared-password cohort reaches for first.
 *
 * Piling on symbol/case requirements past this point buys very little and
 * pushes students towards writing the password on the back of their ID card.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * bcrypt only ever hashes the first 72 BYTES of its input; everything past
 * that is silently discarded. Accepting a longer password would mean quietly
 * ignoring part of what the user typed, so it is rejected outright.
 */
export const MAX_PASSWORD_BYTES = 72;

/** The bulk-import password, plus what a cohort on a shared password picks next. */
const BANNED_PASSWORDS = new Set(
  [
    "klh@123",
    "klh123",
    "password",
    "password1",
    "password123",
    "12345678",
    "123456789",
    "1234567890",
    "qwerty123",
    "iloveyou",
    "changeme",
    "changeme123",
    "student123",
    "canteen123",
    "klhcanteen",
    "abcd1234",
    "admin123",
    "letmein123",
  ].map((p) => p.toLowerCase())
);

export interface PasswordContext {
  /** Rejected as a password — it is printed on the public class roster. */
  rollNumber?: string | null;
  /** Rejected as a password; the local part alone is rejected too. */
  email?: string | null;
  name?: string | null;
}

/**
 * Throws ApiError(400, "WEAK_PASSWORD") with a message the UI can show
 * verbatim. Returns nothing on success.
 */
export function assertPasswordStrength(password: string, context: PasswordContext = {}): void {
  const reject = (message: string): never => {
    throw new ApiError(400, "WEAK_PASSWORD", message);
  };

  if (password !== password.trim()) {
    reject("Password must not start or end with a space.");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    reject(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    reject(`Password must be at most ${MAX_PASSWORD_BYTES} bytes.`);
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    reject("Password must contain at least one letter and one number.");
  }
  if (/^(.)\1+$/.test(password)) {
    reject("Password must not be a single repeated character.");
  }

  const lowered = password.toLowerCase();
  if (BANNED_PASSWORDS.has(lowered)) {
    reject("That password is too common. Please choose something else.");
  }

  // Anything derivable from the public roster is worthless as a secret.
  const identifiers = [
    context.rollNumber,
    context.email,
    context.email?.split("@")[0],
    context.name,
  ]
    .filter((v): v is string => Boolean(v && v.trim()))
    .map((v) => v.trim().toLowerCase());

  for (const identifier of identifiers) {
    if (identifier.length >= 4 && lowered.includes(identifier)) {
      reject("Password must not contain your roll number, email or name.");
    }
  }
}

/**
 * Admin-issued temporary password: readable aloud at the counter, unambiguous
 * in print, and strong enough that guessing it is not a shortcut. The alphabet
 * omits 0/O/1/l/I on purpose — a temp password gets transcribed by hand, and
 * "did you mean zero or oh" is how the reset flow turns into a second visit.
 */
const TEMP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const TEMP_LENGTH = 12;

export function generateTemporaryPassword(): string {
  const bytes = new Uint32Array(TEMP_LENGTH);
  crypto.getRandomValues(bytes);
  // Rejection-free modulo bias is irrelevant at this alphabet size relative to
  // 2^32, and the password is single-use and short-lived either way.
  let out = "";
  for (let i = 0; i < TEMP_LENGTH; i++) {
    out += TEMP_ALPHABET[bytes[i] % TEMP_ALPHABET.length];
  }
  // Guarantee the letter+digit rule so a generated password would itself pass
  // assertPasswordStrength — the student is never handed something the change
  // form would reject if they tried to keep it.
  if (!/[0-9]/.test(out)) out = out.slice(0, -1) + "23456789"[bytes[0] % 8];
  if (!/[A-Za-z]/.test(out)) out = "ABCDEFGH"[bytes[1] % 8] + out.slice(1);
  return out;
}
