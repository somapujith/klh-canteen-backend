import "dotenv/config";
import bcrypt from "bcryptjs";
import { getPrisma } from "../src/lib/prisma.js";

const prisma = getPrisma(process.env.DATABASE_URL!);

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@klh.edu.in";
  const password = process.env.SEED_ADMIN_PASSWORD ?? "changeme123";
  const passwordHash = await bcrypt.hash(password, 10);

  const studentEmail = process.env.SEED_STUDENT_EMAIL ?? "student@klh.edu.in";
  const studentPassword = process.env.SEED_STUDENT_PASSWORD ?? "student123";
  const studentRollNumber = process.env.SEED_STUDENT_ROLL ?? "2400000001";
  const studentPasswordHash = await bcrypt.hash(studentPassword, 12);

  // Snacks Admin
  await prisma.user.upsert({
    where: { email: "snacks_admin@klh.edu.in" },
    update: { passwordHash, name: "Snacks Admin", kitchen: "SNACKS" },
    create: {
      email: "snacks_admin@klh.edu.in",
      passwordHash,
      name: "Snacks Admin",
      role: "ADMIN",
      kitchen: "SNACKS"
    },
  });

  // Meals Admin
  await prisma.user.upsert({
    where: { email: "meals_admin@klh.edu.in" },
    update: { passwordHash, name: "Meals Admin", kitchen: "MEALS" },
    create: {
      email: "meals_admin@klh.edu.in",
      passwordHash,
      name: "Meals Admin",
      role: "ADMIN",
      kitchen: "MEALS"
    },
  });

  // Super Admin
  await prisma.user.upsert({
    where: { email: "superadmin@klh.edu.in" },
    update: { passwordHash, name: "Super Admin" },
    create: {
      email: "superadmin@klh.edu.in",
      passwordHash,
      name: "Super Admin",
      role: "SUPERADMIN",
    },
  });

  // Demo Student (matches the "Student Account" quick-fill on the login page)
  await prisma.user.upsert({
    where: { email: studentEmail },
    update: { passwordHash: studentPasswordHash, name: "Demo Student", rollNumber: studentRollNumber },
    create: {
      email: studentEmail,
      passwordHash: studentPasswordHash,
      name: "Demo Student",
      role: "STUDENT",
      rollNumber: studentRollNumber,
    },
  });

  console.log(`Student seeded: ${studentEmail} (roll ${studentRollNumber})`);
  console.log("Admins seeded: snacks_admin@klh.edu.in & meals_admin@klh.edu.in & superadmin@klh.edu.in");
  await prisma.$disconnect();
}

main();
