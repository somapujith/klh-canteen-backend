-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tokensValidFrom" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

