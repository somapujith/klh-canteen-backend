import { parse } from "csv-parse/sync";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { ApiError } from "../middleware/errorHandler.js";

/** Fallback when DEFAULT_STUDENT_PASSWORD isn't bound. */
export const DEFAULT_STUDENT_PASSWORD = "klh@123";

const EMAIL_DOMAIN = "klh.edu.in";

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
  results: RosterResult[];
}

/** Students log in by roll number; the address only satisfies User.email's NOT NULL + UNIQUE. */
export function emailForRollNumber(rollNumber: string): string {
  return `${rollNumber.toLowerCase()}@${EMAIL_DOMAIN}`;
}

/**
 * Creates STUDENT accounts from a `name,rollNumber` CSV, deriving the email
 * from the roll number and giving everyone the same starting password.
 *
 * Existing students are reported as skipped rather than updated, so a
 * re-uploaded roster never silently resets a password a student has changed.
 */
export async function importStudentRoster(
  prisma: PrismaClient,
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
    const existing = await prisma.user.findMany({
      where: { OR: [{ rollNumber: { in: rollNumbers } }, { email: { in: rollNumbers.map(emailForRollNumber) } }] },
      select: { rollNumber: true, email: true },
    });
    const takenRolls = new Set(existing.map((u) => u.rollNumber).filter(Boolean) as string[]);
    const takenEmails = new Set(existing.map((u) => u.email));

    const fresh = candidates.filter((s) => {
      if (takenRolls.has(s.rollNumber) || takenEmails.has(emailForRollNumber(s.rollNumber))) {
        results.push({ ...s, status: "skipped", reason: "already exists" });
        return false;
      }
      return true;
    });

    if (fresh.length > 0) {
      // Every student starts on the same password, so hash once instead of
      // once per row — 150 bcrypt rounds would exceed the Worker CPU limit.
      const passwordHash = await bcrypt.hash(defaultPassword, 12);
      await prisma.user.createMany({
        data: fresh.map((s) => ({
          role: "STUDENT" as const,
          name: s.name,
          rollNumber: s.rollNumber,
          email: emailForRollNumber(s.rollNumber),
          passwordHash,
        })),
        skipDuplicates: true,
      });
      fresh.forEach((s) => results.push({ ...s, status: "created" }));
    }
  }

  results.sort((a, b) => a.row - b.row);
  return {
    created: results.filter((r) => r.status === "created").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    defaultPassword,
    results,
  };
}
