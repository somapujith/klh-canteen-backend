import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

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
  const catMap = new Map();
  
  for (const c of categories) {
    const created = await prisma.category.upsert({
      where: { name: c.name },
      update: { sortOrder: c.sortOrder },
      create: { name: c.name, sortOrder: c.sortOrder },
    });
    catMap.set(created.name, created.id);
  }

  console.log("Seeding 30 products...");
  
  let i = 1;
  for (const p of products) {
    const categoryId = catMap.get(p.cat);
    const stockQty = Math.floor(Math.random() * 50) + 20; // 20 to 69
    // Using loremflickr for random contextual images based on keyword
    const imageUrl = `https://loremflickr.com/400/400/${p.kw}?random=${i}`;
    
    const existing = await prisma.menuItem.findFirst({ where: { name: p.name } });
    if (!existing) {
      await prisma.menuItem.create({
        data: {
          name: p.name,
          price: p.price,
          imageUrl,
          categoryId,
          stockQty,
          isAvailable: true
        },
      });
    }
    i++;
  }
  
  console.log("Successfully seeded 30 products!");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
