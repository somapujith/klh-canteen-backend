import "dotenv/config";
import { getPool } from "../src/lib/db.js";
import { sql, query } from "../src/db/sql.js";
import { insertMenuItem } from "../src/db/menuItemRepo.js";
import type { Category } from "../src/db/schema.js";

const pool = getPool(process.env.DATABASE_URL!);

const categories = [
  { name: "Beverages", sortOrder: 1 },
  { name: "Snacks", sortOrder: 2 },
  { name: "Meals", sortOrder: 3 },
  { name: "Desserts", sortOrder: 4 },
];

const products = [
  // Beverages
  { name: "Masala Chai", cat: "Beverages", price: "15.00", kw: "tea" },
  { name: "Filter Coffee", cat: "Beverages", price: "20.00", kw: "coffee" },
  { name: "Cold Coffee", cat: "Beverages", price: "60.00", kw: "coldcoffee" },
  { name: "Fresh Lime Soda", cat: "Beverages", price: "30.00", kw: "lime,drink" },
  { name: "Mango Shake", cat: "Beverages", price: "50.00", kw: "mango,drink" },
  { name: "Coca Cola", cat: "Beverages", price: "40.00", kw: "cola" },
  { name: "Bottled Water", cat: "Beverages", price: "20.00", kw: "water,bottle" },

  // Snacks
  { name: "Aloo Samosa", cat: "Snacks", price: "15.00", kw: "samosa" },
  { name: "Veg Puff", cat: "Snacks", price: "20.00", kw: "puff,pastry" },
  { name: "Egg Puff", cat: "Snacks", price: "25.00", kw: "eggpuff" },
  { name: "French Fries", cat: "Snacks", price: "50.00", kw: "fries" },
  { name: "Grilled Sandwich", cat: "Snacks", price: "45.00", kw: "sandwich" },
  { name: "Veg Burger", cat: "Snacks", price: "60.00", kw: "burger" },
  { name: "Vada Pav", cat: "Snacks", price: "20.00", kw: "vadapav" },
  { name: "Onion Pakoda", cat: "Snacks", price: "30.00", kw: "pakoda" },
  { name: "Cheese Nachos", cat: "Snacks", price: "70.00", kw: "nachos" },

  // Meals
  { name: "Veg Thali", cat: "Meals", price: "80.00", kw: "thali" },
  { name: "Chicken Biryani", cat: "Meals", price: "150.00", kw: "biryani" },
  { name: "Veg Fried Rice", cat: "Meals", price: "70.00", kw: "friedrice" },
  { name: "Hakka Noodles", cat: "Meals", price: "70.00", kw: "noodles" },
  { name: "Margherita Pizza", cat: "Meals", price: "120.00", kw: "pizza" },
  { name: "White Sauce Pasta", cat: "Meals", price: "90.00", kw: "pasta" },
  { name: "Masala Dosa", cat: "Meals", price: "50.00", kw: "dosa" },
  { name: "Idli Sambar", cat: "Meals", price: "40.00", kw: "idli" },
  { name: "Chole Bhature", cat: "Meals", price: "70.00", kw: "chole" },

  // Desserts
  { name: "Chocolate Brownie", cat: "Desserts", price: "50.00", kw: "brownie" },
  { name: "Vanilla Ice Cream", cat: "Desserts", price: "30.00", kw: "icecream" },
  { name: "Gulab Jamun (2 pcs)", cat: "Desserts", price: "40.00", kw: "gulabjamun" },
  { name: "Chocolate Donut", cat: "Desserts", price: "45.00", kw: "donut" },
  { name: "Black Forest Pastry", cat: "Desserts", price: "55.00", kw: "pastry" },
];

async function main() {
  console.log("Seeding categories...");
  const catMap = new Map<string, string>();

  for (const { name, sortOrder } of categories) {
    const kitchen = name === "Meals" ? "MEALS" : "SNACKS";
    // Category.name is UNIQUE — upsert on that key, mirroring
    // prisma.category.upsert({ where: { name }, update: { sortOrder, kitchen }, create: {...} }).
    const { rows } = await query<Category>(
      pool,
      sql`
        INSERT INTO "Category" ("id", "name", "sortOrder", "kitchen")
        VALUES (gen_random_uuid(), ${name}, ${sortOrder}, ${kitchen})
        ON CONFLICT ("name") DO UPDATE SET "sortOrder" = EXCLUDED."sortOrder", "kitchen" = EXCLUDED."kitchen"
        RETURNING "id", "name", "sortOrder", "kitchen"
      `
    );
    catMap.set(rows[0].name, rows[0].id);
  }

  console.log("Seeding 30 products...");

  let i = 1;
  for (const p of products) {
    const categoryId = catMap.get(p.cat)!;
    const stockQty = Math.floor(Math.random() * 50) + 20; // 20 to 69
    // picsum.photos (Lorem Picsum) — loremflickr regularly 500s in production,
    // picsum is a stable CDN. Not content-matched to the item, just a seeded
    // deterministic placeholder per product.
    const imageUrl = `https://picsum.photos/seed/${p.kw}-${i}/400/400`;

    // No unique constraint on MenuItem.name — replicate the original
    // find-then-create (skip if a row with this name already exists).
    const { rows: existing } = await query(
      pool,
      sql`SELECT "id" FROM "MenuItem" WHERE "name" = ${p.name} LIMIT 1`
    );
    if (existing.length === 0) {
      await insertMenuItem(pool, {
        name: p.name,
        price: p.price,
        imageUrl,
        categoryId,
        stockQty,
      });
    }
    i++;
  }

  console.log("Successfully seeded 30 products!");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
