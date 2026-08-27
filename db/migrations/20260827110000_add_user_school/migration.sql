-- Second institution (DRK) support: tag each account with the school it
-- belongs to. Every existing row is KLH — the only institution before this.
CREATE TYPE "School" AS ENUM ('KLH', 'DRK');

ALTER TABLE "User" ADD COLUMN "school" "School" NOT NULL DEFAULT 'KLH';
