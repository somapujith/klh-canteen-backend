import { parse } from "csv-parse/sync";
import bcrypt from "bcryptjs";
import type { Pool } from "@neondatabase/serverless";
import * as userRepo from "../db/userRepo.js";
import { ApiError } from "../middleware/errorHandler.js";

/** Fallback when DEFAULT_STUDENT_PASSWORD isn't bound. */
export const DEFAULT_STUDENT_PASSWORD = "klh@123";

/**
 * The domain student usernames USED to be suffixed with.
 *
 * Nothing is written with it any more — see usernameForRollNumber() — but it
 * is still read: rows created before the change still carry it, and login()
 * still accepts it as an identifier so nobody is locked out mid-transition.
 */
export const LEGACY_STUDENT_EMAIL_DOMAIN = "klh.edu.in";

interface RosterRow {
  name?: string;
  rollNumber?: string;
}

export interface RosterResult {
  row: number;
  rollNumber: string;
  name: string;
  status: "created" | "skipped";
  reason?: string;
}

export interface RosterSummary {
  created: number;
  skipped: number;
  defaultPassword: string;
  /**
   * True when the created accounts must set their own password before they can
   * order. Surfaced so the admin UI can tell staff what to say to the students
   * they just imported, rather than leaving them to discover it at checkout.
   */
  mustChangePassword: boolean;
  results: RosterResult[];
}

/**
 * The value written to User.email for a roster-created student — the roll
 * number itself, with no domain attached.
 *
 * User.email is NOT NULL + UNIQUE, so every account needs *something* here,
 * and for a student that something has never been a deliverable address: no
 * mail is routable to <roll>@klh.edu.in, and the synthetic suffix only ever
 * appeared in admin lists and audit logs as noise around the one identifier
 * anybody actually uses. So the column now holds the bare roll number and is,
 * for students, a username rather than an email.
 *
 * Lower-cased on the way in — matching what the old synthesised address did —
 * so two roster rows differing only in the case of an alphanumeric roll number
 * still collide on the unique index instead of becoming two accounts. The
 * `rollNumber` column keeps the roster's original casing.
 *
 * Admin and superadmin accounts are untouched by any of this: their emails are
 * real, are typed by a human, and never pass through here.
 */
export function usernameForRollNumber(rollNumber: string): string {
  return rollNumber.trim().toLowerCase();
}

/**
 * What usernameForRollNumber() would have returned before the change.
 *
 * Only used to look rows up. A roster re-uploaded before the backfill has run
 * must still recognise its own students as "already exists", whichever form
 * their username is currently stored in.
 */
export function legacyEmailForRollNumber(rollNumber: string): string {
  return `${rollNumber.trim().toLowerCase()}@${LEGACY_STUDENT_EMAIL_DOMAIN}`;
}

/**
 * Creates STUDENT accounts from a `name,rollNumber` CSV, using the roll number
 * itself as the username and giving everyone the same starting password.
 *
 * Existing students are reported as skipped rather than updated, so a
 * re-uploaded roster never silently resets a password a student has changed.
 */
export async function importStudentRoster(
  pool: Pool,
  csvText: string,
  defaultPassword: string = DEFAULT_STUDENT_PASSWORD
): Promise<RosterSummary> {
  let rows: RosterRow[];
  try {
    rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch {
    throw new ApiError(400, "INVALID_CSV", "Could not parse the CSV file.");
  }

  if (rows.length === 0) {
    throw new ApiError(400, "EMPTY_CSV", "The CSV file contains no rows.");
  }
  if (!("name" in rows[0]) || !("rollNumber" in rows[0])) {
    throw new ApiError(400, "MISSING_COLUMNS", "The CSV must have 'name' and 'rollNumber' columns.");
  }

  const results: RosterResult[] = [];
  const candidates: { row: number; name: string; rollNumber: string }[] = [];
  const seenInFile = new Set<string>();

  rows.forEach((row, i) => {
    const rowNum = i + 1;
    const name = row.name?.trim() ?? "";
    const rollNumber = row.rollNumber?.trim() ?? "";

    if (!name || !rollNumber) {
      results.push({ row: rowNum, rollNumber, name, status: "skipped", reason: "missing name or rollNumber" });
      return;
    }
    if (seenInFile.has(rollNumber)) {
      results.push({ row: rowNum, rollNumber, name, status: "skipped", reason: "duplicate in file" });
      return;
    }

    seenInFile.add(rollNumber);
    candidates.push({ row: rowNum, name, rollNumber });
  });

  if (candidates.length > 0) {
    // One lookup for the whole file — a query per row would blow the Worker's
    // CPU/subrequest budget on a 150-student roster.
    const rollNumbers = candidates.map((s) => s.rollNumber);
    // Students imported before usernames dropped the domain still need to be
    // recognised as "already exists" by their legacy email arm. Drop that arm
    // once the backfill has run everywhere.
    const existing = await userRepo.findExistingByRollNumbersOrEmails(
      pool,
      rollNumbers,
      rollNumbers.map(usernameForRollNumber),
      rollNumbers.map(legacyEmailForRollNumber),
    );
    const takenRolls = new Set(existing.map((u) => u.rollNumber).filter(Boolean) as string[]);
    const takenEmails = new Set(existing.map((u) => u.email));

    const fresh = candidates.filter((s) => {
      if (
        takenRolls.has(s.rollNumber) ||
        takenEmails.has(usernameForRollNumber(s.rollNumber)) ||
        takenEmails.has(legacyEmailForRollNumber(s.rollNumber))
      ) {
        results.push({ ...s, status: "skipped", reason: "already exists" });
        return false;
      }
      return true;
    });

    if (fresh.length > 0) {
      // Every student starts on the same password, so hash once instead of
      // once per row — 150 bcrypt rounds would exceed the Worker CPU limit.
      const passwordHash = await bcrypt.hash(defaultPassword, 12);
      /**
       * Every student created here shares one password, and their roll
       * number — the thing they log in with — is printed on a public class
       * roster. So the account is, on creation, readable by the whole
       * class. mustChangePassword makes that state transitional: they can
       * sign in, and the only thing they can do with that session is
       * replace the shared password. requireAuth() refuses everything else,
       * ordering included. userRepo.insertStudentsSkipDuplicates() sets it
       * TRUE unconditionally — set only on rows this import CREATES.
       * Students already in the table are reported as "already exists" and
       * are never written to, so a re-uploaded roster cannot flag a cohort
       * that is already live — see the backfill note in scripts/seedAdmin.ts.
       */
      await userRepo.insertStudentsSkipDuplicates(
        pool,
        fresh.map((s) => ({
          name: s.name,
          rollNumber: s.rollNumber,
          email: usernameForRollNumber(s.rollNumber),
          passwordHash,
        })),
      );
      fresh.forEach((s) => results.push({ ...s, status: "created" }));
    }
  }

  results.sort((a, b) => a.row - b.row);
  return {
    created: results.filter((r) => r.status === "created").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    defaultPassword,
    mustChangePassword: true,
    results,
  };
}
