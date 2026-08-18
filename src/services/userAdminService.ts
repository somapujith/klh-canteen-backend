import bcrypt from "bcrypt";
import type { Kitchen, Role } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../middleware/errorHandler.js";

const userSelect = {
  id: true,
  role: true,
  rollNumber: true,
  email: true,
  name: true,
  kitchen: true,
  createdAt: true,
} as const;

export async function listUsers() {
  return prisma.user.findMany({
    select: userSelect,
    orderBy: { createdAt: "desc" },
  });
}

interface CreateUserInput {
  role: Role;
  name: string;
  email: string;
  password: string;
  rollNumber?: string;
  kitchen?: Kitchen;
}

export async function createUser(input: CreateUserInput) {
  const passwordHash = await bcrypt.hash(input.password, 10);
  try {
    return await prisma.user.create({
      data: {
        role: input.role,
        name: input.name,
        email: input.email,
        passwordHash,
        rollNumber: input.rollNumber,
        kitchen: input.role === "ADMIN" ? input.kitchen : undefined,
      },
      select: userSelect,
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      throw new ApiError(409, "EMAIL_TAKEN", "A user with this email already exists");
    }
    throw err;
  }
}

interface UpdateUserInput {
  name?: string;
  kitchen?: Kitchen | null;
  role?: Role;
  password?: string;
}

export async function updateUser(id: string, input: UpdateUserInput) {
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.role !== undefined) data.role = input.role;
  if (input.kitchen !== undefined) data.kitchen = input.kitchen;
  if (input.password) data.passwordHash = await bcrypt.hash(input.password, 10);

  try {
    return await prisma.user.update({
      where: { id },
      data,
      select: userSelect,
    });
  } catch (err: any) {
    if (err?.code === "P2025") {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }
    throw err;
  }
}

export async function deleteUser(id: string, actorId: string) {
  if (id === actorId) {
    throw new ApiError(400, "CANNOT_DELETE_SELF", "You cannot delete your own account");
  }
  try {
    await prisma.user.delete({ where: { id } });
  } catch (err: any) {
    if (err?.code === "P2025") {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }
    if (err?.code === "P2003") {
      throw new ApiError(409, "USER_HAS_ORDERS", "Cannot delete a user with existing orders");
    }
    throw err;
  }
}
