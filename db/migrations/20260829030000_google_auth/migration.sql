-- DRK student "Sign in with Google" support. `googleId` (the token's stable
-- `sub` claim) is the identity key, not email, since a user can change their
-- Google account's email but not its sub. Partial unique index so existing
-- password-only rows (googleId = NULL) never collide with each other.
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
ALTER TABLE "User" ADD COLUMN "googleEmail" TEXT;

CREATE UNIQUE INDEX "User_googleId_key" ON "User" ("googleId") WHERE "googleId" IS NOT NULL;
