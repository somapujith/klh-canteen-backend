import "dotenv/config";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { getPool } from "../src/lib/db.js";
import { sql, query } from "../src/db/sql.js";
import type { User } from "../src/db/schema.js";

const pool = getPool(process.env.DATABASE_URL!);

async function main() {
  const passwordHash = await bcrypt.hash("student123", 12);
  await query<User>(
    pool,
    sql`
      INSERT INTO "User" ("id", "role", "email", "rollNumber", "passwordHash", "name", "mustChangePassword")
      VALUES (${crypto.randomUUID()}, 'STUDENT'::"Role", 'student@klh.edu.in', '23BCE001', ${passwordHash}, 'Test Student', false)
      ON CONFLICT ("email") DO UPDATE SET
        "mustChangePassword" = false,
        "isActive" = true
      RETURNING *
    `,
  );
  console.log("Seeded student: student@klh.edu.in (Roll: 23BCE001) / student123");
  await pool.end();
}
main();
