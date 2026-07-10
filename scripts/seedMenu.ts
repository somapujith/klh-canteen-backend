import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

async function main() {
  console.log("Seeding menu categories and items...");

  // Create Categories
  const categories = [
    { name: "Hot Beverages", sortOrder: 1 },
    { name: "Cold Beverages", sortOrder: 2 },
    { name: "Snacks", sortOrder: 3 },
    { name: "Meals", sortOrder: 4 },
    { name: "Desserts", sortOrder: 5 },
  ];

  const categoryMap: Record<string, string> = {};

  for (const cat of categories) {
    const created = await prisma.category.upsert({
      where: { name: cat.name },
      update: {},
      create: cat,
    });
    categoryMap[cat.name] = created.id;
  }

  const items = [
    // Hot Beverages
    { name: "Masala Chai", imageUrl: "https://images.unsplash.com/photo-1576092762791-dd9e2220abd4?w=500&q=80", price: 15.00, stockQty: 100, categoryId: categoryMap["Hot Beverages"] },
    { name: "Filter Coffee", imageUrl: "https://images.unsplash.com/photo-1497935586351-b67a49e012bf?w=500&q=80", price: 20.00, stockQty: 50, categoryId: categoryMap["Hot Beverages"] },
    { name: "Green Tea", imageUrl: "https://images.unsplash.com/photo-1627492275510-43187c32b5d4?w=500&q=80", price: 25.00, stockQty: 40, categoryId: categoryMap["Hot Beverages"] },
    { name: "Hot Chocolate", imageUrl: "https://images.unsplash.com/photo-1542990253-0d0f5be5f0ed?w=500&q=80", price: 40.00, stockQty: 30, categoryId: categoryMap["Hot Beverages"] },
    { name: "Cappuccino", imageUrl: "https://images.unsplash.com/photo-1534040385115-332cb5c64625?w=500&q=80", price: 50.00, stockQty: 25, categoryId: categoryMap["Hot Beverages"] },

    // Cold Beverages
    { name: "Cold Coffee", imageUrl: "https://images.unsplash.com/photo-1461023058943-0708e5215082?w=500&q=80", price: 60.00, stockQty: 50, categoryId: categoryMap["Cold Beverages"] },
    { name: "Lemon Iced Tea", imageUrl: "https://images.unsplash.com/photo-1499638673689-79a0b5115d87?w=500&q=80", price: 45.00, stockQty: 60, categoryId: categoryMap["Cold Beverages"] },
    { name: "Mango Shake", imageUrl: "https://images.unsplash.com/photo-1546892978-a8d6722fbdb8?w=500&q=80", price: 70.00, stockQty: 30, categoryId: categoryMap["Cold Beverages"] },
    { name: "Oreo Shake", imageUrl: "https://images.unsplash.com/photo-1572490122747-3968b75bf699?w=500&q=80", price: 80.00, stockQty: 20, categoryId: categoryMap["Cold Beverages"] },
    { name: "Fresh Lime Soda", imageUrl: "https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?w=500&q=80", price: 35.00, stockQty: 45, categoryId: categoryMap["Cold Beverages"] },
    { name: "Water Bottle (500ml)", imageUrl: "https://images.unsplash.com/photo-1523362628745-0c100150b504?w=500&q=80", price: 10.00, stockQty: 200, categoryId: categoryMap["Cold Beverages"] },

    // Snacks
    { name: "Samosa (2 pcs)", imageUrl: "https://images.unsplash.com/photo-1601050690597-df0568f70950?w=500&q=80", price: 30.00, stockQty: 100, categoryId: categoryMap["Snacks"] },
    { name: "Vada Pav", imageUrl: "https://images.unsplash.com/photo-1601050690597-df0568f70950?w=500&q=80", price: 25.00, stockQty: 80, categoryId: categoryMap["Snacks"] },
    { name: "French Fries", imageUrl: "https://images.unsplash.com/photo-1576107232684-1279f390859f?w=500&q=80", price: 50.00, stockQty: 60, categoryId: categoryMap["Snacks"] },
    { name: "Cheese Sandwich", imageUrl: "https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=500&q=80", price: 45.00, stockQty: 40, categoryId: categoryMap["Snacks"] },
    { name: "Paneer Tikka Roll", imageUrl: "https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=500&q=80", price: 80.00, stockQty: 30, categoryId: categoryMap["Snacks"] },
    { name: "Maggi", imageUrl: "https://images.unsplash.com/photo-1612929633738-8fe01f746761?w=500&q=80", price: 40.00, stockQty: 50, categoryId: categoryMap["Snacks"] },
    { name: "Puff Pastry", imageUrl: "https://images.unsplash.com/photo-1509365465994-3e2840507317?w=500&q=80", price: 20.00, stockQty: 40, categoryId: categoryMap["Snacks"] },

    // Meals
    { name: "Veg Thali", imageUrl: "https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=500&q=80", price: 120.00, stockQty: 50, categoryId: categoryMap["Meals"] },
    { name: "Chicken Biryani", imageUrl: "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=500&q=80", price: 150.00, stockQty: 40, categoryId: categoryMap["Meals"] },
    { name: "Veg Fried Rice", imageUrl: "https://images.unsplash.com/photo-1603133872878-684f208fb84b?w=500&q=80", price: 90.00, stockQty: 45, categoryId: categoryMap["Meals"] },
    { name: "Chole Bhature", imageUrl: "https://images.unsplash.com/photo-1517409249050-dfc7913ae30e?w=500&q=80", price: 80.00, stockQty: 30, categoryId: categoryMap["Meals"] },
    { name: "Paneer Butter Masala & Roti", imageUrl: "https://images.unsplash.com/photo-1589302168068-964664d93cb0?w=500&q=80", price: 130.00, stockQty: 35, categoryId: categoryMap["Meals"] },
    { name: "Egg Curry Meal", imageUrl: "https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=500&q=80", price: 110.00, stockQty: 25, categoryId: categoryMap["Meals"] },

    // Desserts
    { name: "Gulab Jamun (2 pcs)", imageUrl: "https://images.unsplash.com/photo-1605197148007-679bc298daff?w=500&q=80", price: 40.00, stockQty: 50, categoryId: categoryMap["Desserts"] },
    { name: "Chocolate Brownie", imageUrl: "https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=500&q=80", price: 60.00, stockQty: 30, categoryId: categoryMap["Desserts"] },
    { name: "Vanilla Ice Cream", imageUrl: "https://images.unsplash.com/photo-1563805042-7684c8a9e9ce?w=500&q=80", price: 30.00, stockQty: 40, categoryId: categoryMap["Desserts"] },
    { name: "Fruit Salad", imageUrl: "https://images.unsplash.com/photo-1490474418585-ba9bad8fd0ea?w=500&q=80", price: 50.00, stockQty: 20, categoryId: categoryMap["Desserts"] },
    { name: "Rasmalai", imageUrl: "https://images.unsplash.com/photo-1605197148007-679bc298daff?w=500&q=80", price: 55.00, stockQty: 25, categoryId: categoryMap["Desserts"] },
  ];

  for (const item of items) {
    const existing = await prisma.menuItem.findFirst({ where: { name: item.name } });
    if (!existing) {
      await prisma.menuItem.create({
        data: item,
      });
    }
  }

  console.log(`Seeded ${categories.length} categories and ${items.length} menu items.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
