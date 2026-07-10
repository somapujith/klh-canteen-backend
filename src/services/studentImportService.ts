import { parse } from "csv-parse/sync";
import bcrypt from "bcrypt";
import { prisma } from "../lib/prisma.js";

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

export async function importStudentsFromCsv(csvText: string): Promise<ImportResult[]> {
  const rows: CsvRow[] = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  const results: ImportResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    if (!row.name || !row.rollNumber || !row.email || !row.password) {
      results.push({ row: rowNum, rollNumber: row.rollNumber ?? "", status: "skipped", reason: "missing field" });
      continue;
    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ rollNumber: row.rollNumber }, { email: row.email }] },
    });
    if (existing) {
      results.push({ row: rowNum, rollNumber: row.rollNumber, status: "skipped", reason: "duplicate" });
      continue;
    }

    const passwordHash = await bcrypt.hash(row.password, 12);
    await prisma.user.create({
      data: {
        role: "STUDENT",
        name: row.name,
        rollNumber: row.rollNumber,
        email: row.email,
        passwordHash,
      },
    });
    results.push({ row: rowNum, rollNumber: row.rollNumber, status: "created" });
  }

  return results;
}
