-- MenuItemImage.uploadedById previously had no ON DELETE clause, which
-- defaults to NO ACTION and permanently blocks deleting a staff user who has
-- ever uploaded a menu photo. That FK violation surfaced as a misleading
-- "Cannot delete a user with existing orders" error (userAdminService.ts's
-- FK-violation handling only expected Order's FK), silently and confusingly
-- blocking staff offboarding.
--
-- Unlike Order.studentId / AuditLog.actorId (ON DELETE RESTRICT, deliberately
-- — order and audit history integrity is an invariant the app enforces
-- elsewhere), photo attribution is provenance metadata only: nothing else in
-- this codebase reads or depends on "who uploaded this photo" once the photo
-- exists. Losing that attribution on user deletion is acceptable; blocking
-- offboarding over it is not. Switching to ON DELETE SET NULL requires the
-- column to become nullable.
ALTER TABLE "MenuItemImage" ALTER COLUMN "uploadedById" DROP NOT NULL;

ALTER TABLE "MenuItemImage" DROP CONSTRAINT "MenuItemImage_uploadedById_fkey";

ALTER TABLE "MenuItemImage"
  ADD CONSTRAINT "MenuItemImage_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL;
