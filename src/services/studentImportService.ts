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
  const results: ImportResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    if (!row.name || !row.rollNumber || !row.email || !row.password) {
      results.push({ row: rowNum, rollNumber: row.rollNumber ?? "", status: "skipped", reason: "missing field" });
      continue;
    }

    const existing = await userRepo.existsByRollNumberOrEmail(pool, row.rollNumber, row.email);
    if (existing) {
      results.push({ row: rowNum, rollNumber: row.rollNumber, status: "skipped", reason: "duplicate" });
      continue;
    }

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
       * Same rule as the roster import: an account whose password was chosen
       * by whoever wrote the CSV is not yet the student's own. They must
       * replace it before requireAuth() will let them do anything but that.
       */
      mustChangePassword: true,
    });
    results.push({ row: rowNum, rollNumber: row.rollNumber, status: "created" });
  }

  return results;
}
