import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";

export interface TokenPayload {
  sub: string;
  role: Role;
  kitchen?: string | null;
  /**
   * Issued-at, seconds since epoch. jsonwebtoken fills this in automatically
   * when it is absent, but it is part of the declared shape because token
   * revocation depends on it: requireAuth() rejects any token whose `iat`
   * predates the user's `tokensValidFrom` cutoff. A token without an `iat`
   * cannot be revoked, so verifyToken() refuses to hand one back.
   */
  iat?: number;
  exp?: number;
}

export interface SignOptions {
  /**
   * Pin the token's issued-at instead of letting it default to "now".
   *
   * Used when a request both moves a user's `tokensValidFrom` cutoff forward
   * and mints them a replacement token (change-password): the replacement is
   * signed with `iat` exactly on the new cutoff so it survives the very
   * revocation that kills every one of their older tokens. Truncation to whole
   * seconds is what makes this necessary — a default `iat` of floor(now) can
   * land a millisecond *behind* a cutoff computed from the same instant.
   */
  iatSeconds?: number;
}

export function signToken(payload: TokenPayload, secret: string, options: SignOptions = {}): string {
  if (!secret) throw new Error("JWT_SECRET not set");
  const claims: TokenPayload =
    options.iatSeconds !== undefined ? { ...payload, iat: options.iatSeconds } : { ...payload };
  return jwt.sign(claims, secret, { expiresIn: "12h" });
}

export function verifyToken(token: string, secret: string): TokenPayload {
  if (!secret) throw new Error("JWT_SECRET not set");
  const payload = jwt.verify(token, secret) as TokenPayload;
  // Defence in depth: a token with no `iat` is outside the reach of
  // tokensValidFrom, so it would be permanently unrevokable. Every token this
  // codebase signs carries one; anything else is treated as invalid rather
  // than quietly granted an exemption from revocation.
  if (typeof payload.iat !== "number") {
    throw new Error("Token is missing iat");
  }
  return payload;
}

/**
 * A revocation cutoff guaranteed to be strictly newer than every token already
 * in circulation, and safe to reuse as a replacement token's `iat`.
 *
 * JWT `iat` has one-second resolution, so a cutoff of "now" is ambiguous
 * against a token minted in the same second. Rounding up to the next whole
 * second removes the ambiguity in the direction that matters: every existing
 * token has `iat <= floor(now) < cutoff` and dies.
 */
export function revocationCutoffSeconds(now: number = Date.now()): number {
  return Math.floor(now / 1000) + 1;
}

/** True when `iat` puts the token strictly before the user's revocation cutoff. */
export function isTokenRevoked(iatSeconds: number, tokensValidFrom: Date | null | undefined): boolean {
  if (!tokensValidFrom) return false;
  return iatSeconds * 1000 < tokensValidFrom.getTime();
}
