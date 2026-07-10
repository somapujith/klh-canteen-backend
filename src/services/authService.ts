import bcrypt from "bcrypt";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../lib/jwt.js";
import { ApiError } from "../middleware/errorHandler.js";

export async function login(identifier: string, password: string) {
  const user = await prisma.user.findFirst({
    where: { OR: [{ email: identifier }, { rollNumber: identifier }] },
  });
  if (!user) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");

  const token = signToken({ sub: user.id, role: user.role });
  return { token, role: user.role, name: user.name };
}
