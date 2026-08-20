import "dotenv/config";
import { getPrisma } from "../src/lib/prisma.js";
import bcrypt from "bcryptjs";

const prisma = getPrisma(process.env.DATABASE_URL!);

async function main() {
  const passwordHash = await bcrypt.hash("student123", 12);
  await prisma.user.upsert({
    where: { email: "student@klh.edu.in" },
    update: {},
    create: { role: "STUDENT", email: "student@klh.edu.in", rollNumber: "23BCE001", passwordHash, name: "Test Student" },
  });
  console.log("Seeded student: student@klh.edu.in (Roll: 23BCE001) / student123");
  await prisma.$disconnect();
}
main();
