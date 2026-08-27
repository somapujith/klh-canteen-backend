import { parse } from "csv-parse/sync";
import bcrypt from "bcryptjs";
import type { Pool } from "@neondatabase/serverless";
import * as userRepo from "../db/userRepo.js";

interface CsvRow {
  name: string;
  rollNumber: string;
  email: string;
  password: string;
}

interface ImportResult {
  row: number;
  rollNumber: string;
  status: "created" | "skipped";
  reason?: string;
}

export async function importStudentsFromCsv(pool: Pool, csvText: string): Promise<ImportResult[]> {
  const rows: CsvRow[] = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  // Indexed by original row position so results stay in file order — the two
  // passes below resolve different rows at different times, and pushing
  // sequentially instead would emit them in resolution order, not row order.
  const results: (ImportResult | undefined)[] = new Array(rows.length);

  // Two duplicate sources: a rollNumber/email repeated within this same file
  // (caught here, first occurrence wins — matches the pre-batching behaviour
  // where an early row's insert would make a later identical row fail its
  // own existence check), and one that already exists in the database
  // (caught below, via one batched lookup instead of one query per row).
  const seenRolls = new Set<string>();
  const seenEmails = new Set<string>();
  const candidates: { row: number; index: number; data: CsvRow }[] = [];
  rows.forEach((row, index) => {
    const rowNum = index + 1;
    if (!row.name || !row.rollNumber || !row.email || !row.password) {
      results[index] = { row: rowNum, rollNumber: row.rollNumber ?? "", status: "skipped", reason: "missing field" };
      return;
    }
    if (seenRolls.has(row.rollNumber) || seenEmails.has(row.email)) {
      results[index] = { row: rowNum, rollNumber: row.rollNumber, status: "skipped", reason: "duplicate" };
      return;
    }
    seenRolls.add(row.rollNumber);
    seenEmails.add(row.email);
    candidates.push({ row: rowNum, index, data: row });
  });

  if (candidates.length > 0) {
    // One lookup for the whole file instead of one per row — see
    // studentRosterService.ts's identical fix for the same class of bug. The
    // third arg (legacyEmails) is unused here since this importer's rows
    // already carry a literal email rather than a synthesized one; an empty
    // array matches nothing, which is what we want.
    const existing = await userRepo.findExistingByRollNumbersOrEmails(
      pool,
      candidates.map((c) => c.data.rollNumber),
      candidates.map((c) => c.data.email),
      [],
    );
    const takenRolls = new Set(existing.map((u) => u.rollNumber).filter(Boolean) as string[]);
    const takenEmails = new Set(existing.map((u) => u.email));

    for (const { row: rowNum, index, data: row } of candidates) {
      if (takenRolls.has(row.rollNumber) || takenEmails.has(row.email)) {
        results[index] = { row: rowNum, rollNumber: row.rollNumber, status: "skipped", reason: "duplicate" };
        continue;
      }

      // Unlike the roster importer, every row here carries its own
      // caller-supplied password, so the hash can't be collapsed to one
      // call — it genuinely differs per row.
      const passwordHash = await bcrypt.hash(row.password, 12);
      await userRepo.insert(pool, {
        role: "STUDENT",
        name: row.name,
        rollNumber: row.rollNumber,
        email: row.email,
        passwordHash,
        // This importer's CSV shape has no school column — every row it has
        // ever created is KLH, the DB column's own default.
        school: "KLH",
        /**
         * Same rule as the roster import: an account whose password was
         * chosen by whoever wrote the CSV is not yet the student's own. They
         * must replace it before requireAuth() will let them do anything but
         * that.
         */
        mustChangePassword: true,
      });
      results[index] = { row: rowNum, rollNumber: row.rollNumber, status: "created" };
    }
  }

  return results as ImportResult[];
}
