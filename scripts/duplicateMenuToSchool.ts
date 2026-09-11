/**
 * One-off: duplicate every KLH category, menu item, and uploaded image into
 * DRK as fully independent rows. Run once, then delete or leave inert — not
 * part of the regular migration/deploy flow.
 *
 * Goes through the same repo functions the app itself uses (categoryRepo,
 * menuItemRepo, menuItemImageRepo.putImage) rather than hand-rolled INSERTs,
 * so the duplicates get fresh UUIDs, the denormalized MenuItem.school stays
 * correct, and image bytes stay in sync with MenuItem.imageHash exactly the
 * way a real upload would leave them.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/duplicateMenuToSchool.ts
 */
import { Pool } from "@neondatabase/serverless";
import * as categoryRepo from "../src/db/categoryRepo.js";
import * as menuItemRepo from "../src/db/menuItemRepo.js";
import * as menuItemImageRepo from "../src/db/menuItemImageRepo.js";

const SOURCE_SCHOOL = "KLH" as const;
const TARGET_SCHOOL = "DRK" as const;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Attributed to a real admin of the target school (PutImageInput.uploadedById
    // is non-nullable) rather than any KLH admin — the duplicated images now
    // belong to DRK's menu, so a DRK identity is the correct owner of record.
    const { rows: targetAdmins } = await pool.query<{ id: string }>(
      `SELECT "id" FROM "User" WHERE "school" = $1 AND "role" IN ('ADMIN', 'SUPERADMIN') LIMIT 1`,
      [TARGET_SCHOOL],
    );
    const attributedTo = targetAdmins[0]?.id;
    if (!attributedTo) throw new Error(`No admin/superadmin found for ${TARGET_SCHOOL} to attribute images to.`);

    const existingTarget = await categoryRepo.findCategories(pool, undefined, TARGET_SCHOOL);
    if (existingTarget.length > 0) {
      throw new Error(
        `${TARGET_SCHOOL} already has ${existingTarget.length} categories — refusing to duplicate on top of existing data. Run manually with care if this is intentional.`,
      );
    }

    const sourceCategories = await categoryRepo.findCategories(pool, undefined, SOURCE_SCHOOL);
    console.log(`Found ${sourceCategories.length} ${SOURCE_SCHOOL} categories to duplicate.`);

    let totalItems = 0;
    let totalImages = 0;

    for (const category of sourceCategories) {
      const newCategory = await categoryRepo.insertCategory(pool, {
        name: category.name,
        sortOrder: category.sortOrder,
        kitchen: category.kitchen,
        school: TARGET_SCHOOL,
      });
      console.log(`  Category "${category.name}" (${category.kitchen}) -> ${newCategory.id}`);

      const items = await menuItemRepo.findMenuItemsByCategoryIds(pool, [category.id]);
      for (const item of items) {
        const newItem = await menuItemRepo.insertMenuItem(pool, {
          name: item.name,
          imageUrl: item.imageUrl,
          price: item.price,
          stockQty: item.stockQty,
          categoryId: newCategory.id,
          sortOrder: item.sortOrder,
          servingInfo: item.servingInfo,
          servingInfoVisible: item.servingInfoVisible,
          school: TARGET_SCHOOL,
        });
        totalItems++;

        if (item.imageHash) {
          const image = await menuItemImageRepo.findImage(pool, item.id);
          if (image) {
            await menuItemImageRepo.putImage(pool, {
              menuItemId: newItem.id,
              bytes: image.bytes,
              mimeType: image.mimeType,
              width: image.width,
              height: image.height,
              uploadedById: attributedTo,
              hash: item.imageHash,
            });
            totalImages++;
          } else {
            console.warn(`    WARNING: ${item.name} has imageHash but no MenuItemImage row — skipped image copy.`);
          }
        }
      }
      console.log(`    ${items.length} items duplicated.`);
    }

    console.log(`\nDone. ${sourceCategories.length} categories, ${totalItems} items, ${totalImages} images duplicated into ${TARGET_SCHOOL}.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
