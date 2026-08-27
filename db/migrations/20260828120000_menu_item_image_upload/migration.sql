-- Admin-uploaded, optimized menu item photos, stored in Postgres.
--
-- A separate table (not a `bytea` column on "MenuItem") is deliberate:
-- menuItemRepo.ts funnels every read through one ALL_COLUMNS constant shared
-- by the hot menu-list path. A blob column there is a one-line mistake away
-- from shipping megabytes on every request, with no compile-time signal.
-- Splitting the table makes that structurally unreachable.
--
-- "imageHash" on "MenuItem" is the sha256 of the stored bytes (first 32 hex
-- chars), denormalized so the hot list path gets it for free. It is what
-- makes the serving URL content-addressed and cacheable forever.
CREATE TABLE "MenuItemImage" (
  "menuItemId" TEXT PRIMARY KEY REFERENCES "MenuItem"("id") ON DELETE CASCADE,
  "bytes" BYTEA NOT NULL,
  "mimeType" TEXT NOT NULL CHECK ("mimeType" IN ('image/webp', 'image/jpeg')),
  "byteSize" INTEGER NOT NULL CHECK ("byteSize" = octet_length("bytes") AND "byteSize" <= 524288),
  "width" INTEGER NOT NULL CHECK ("width" > 0 AND "width" <= 2048),
  "height" INTEGER NOT NULL CHECK ("height" > 0 AND "height" <= 2048),
  "uploadedById" TEXT NOT NULL REFERENCES "User"("id"),
  "createdAt" TIMESTAMP NOT NULL DEFAULT now()
);

ALTER TABLE "MenuItem" ADD COLUMN "imageHash" TEXT;

-- An item created via upload has no pasted URL. Existing rows keep their
-- imageUrl untouched — resolution order (imageHash -> imageUrl -> placeholder)
-- lives in the frontend's menuImageSrc() helper, not in a backfill. A backfill
-- would mean the Worker fetching arbitrary admin-pasted URLs, which is SSRF
-- into Cloudflare's internal network and the campus LAN for a cosmetic gain.
ALTER TABLE "MenuItem" ALTER COLUMN "imageUrl" DROP NOT NULL;
