import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";

export interface TokenPayload {
  sub: string;
  role: Role;
  kitchen?: string | null;
}

export function signToken(payload: TokenPayload, secret: string): string {
  if (!secret) throw new Error("JWT_SECRET not set");
  return jwt.sign(payload, secret, { expiresIn: "12h" });
}

export function verifyToken(token: string, secret: string): TokenPayload {
  if (!secret) throw new Error("JWT_SECRET not set");
  return jwt.verify(token, secret) as TokenPayload;
}
