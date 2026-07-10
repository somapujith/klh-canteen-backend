import "dotenv/config";
import bcrypt from "bcrypt";
import { prisma } from "../src/lib/prisma.js";

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@klh.edu.in";
  const password = process.env.SEED_ADMIN_PASSWORD ?? "changeme123";
  const passwordHash = await bcrypt.hash("changeme123", 10);

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

  console.log("Admins seeded: snacks_admin@klh.edu.in & meals_admin@klh.edu.in");
  await prisma.$disconnect();
}

main();
