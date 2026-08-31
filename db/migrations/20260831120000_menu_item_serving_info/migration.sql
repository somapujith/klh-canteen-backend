-- Free-text portion info the admin types themselves ("500g", "6 pcs", "1 plate")
-- rather than a number the app tracks. Kept as one nullable text column plus a
-- visibility flag, mirroring how isAvailable is independent of stockQty: the
-- text can stay saved while hidden from the customer menu.
ALTER TABLE "MenuItem" ADD COLUMN "servingInfo" TEXT;
ALTER TABLE "MenuItem" ADD COLUMN "servingInfoVisible" BOOLEAN NOT NULL DEFAULT false;
