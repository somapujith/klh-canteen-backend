import { Hono } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { ApiError } from "../middleware/errorHandler.js";
import {
  createCategory,
  updateCategory,
  deleteCategory,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  bulkUpdateCategoryItems,
} from "../services/menuService.js";
import { uploadMenuItemImage, deleteMenuItemImage, MAX_STORED_IMAGE_BYTES } from "../services/menuImageService.js";
import { listStockRequests, notifyRestocked } from "../services/stockRequestService.js";
import { sseService } from "../services/sseService.js";
import { logAction } from "../services/auditService.js";
import { getRequestPool, getBindings } from "../lib/context.js";
import type { AppEnv } from "../types.js";

export const adminMenuRouter = new Hono<AppEnv>();

const categorySchema = z.object({ name: z.string().min(1), sortOrder: z.number().int().default(0) });
const menuItemSchema = z.object({
  name: z.string().min(1),
  // Deprecated fallback — new items are photographed via the upload
  // endpoint below. Kept optional so admins pasting a URL still works.
  imageUrl: z.string().url().max(2048).optional(),
  price: z.string().regex(/^\d+(\.\d{1,2})?$/),
  stockQty: z.number().int().min(0),
  categoryId: z.string().uuid(),
});
const menuItemUpdateSchema = menuItemSchema.partial();
const idParamSchema = z.string().uuid();

adminMenuRouter.post("/categories", requireAuth("ADMIN"), async (c) => {
  const { name, sortOrder } = categorySchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const category = await createCategory(pool, name, sortOrder, user.kitchen || "SNACKS");
  return c.json(category, 201);
});

adminMenuRouter.patch("/categories/:id", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const data = categorySchema.partial().parse(await c.req.json());
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const category = await updateCategory(pool, id, data, user.kitchen || undefined);
  return c.json(category);
});

adminMenuRouter.delete("/categories/:id", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const { archivedItems } = await deleteCategory(pool, id, user.kitchen || undefined);
  await logAction(pool, user.id, "CATEGORY_DELETE", "Category", id, { archivedItems });
  // The cascade takes the category's items off the menu with it, so customers
  // holding a stale menu have to be told, exactly as the item delete does.
  await sseService.broadcastMenuUpdate(getBindings(c));
  return c.body(null, 204);
});

const bulkUpdateSchema = z.object({
  isAvailable: z.boolean().optional(),
  stockQty: z.number().int().min(0).optional(),
});

adminMenuRouter.patch("/categories/:id/bulk-items", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const data = bulkUpdateSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  await bulkUpdateCategoryItems(pool, id, data, user.kitchen || undefined);
  await logAction(pool, user.id, "CATEGORY_BULK_UPDATE", "Category", id, data);
  await sseService.broadcastMenuUpdate(getBindings(c));
  return c.json({ success: true });
});

adminMenuRouter.post("/menu-items", requireAuth("ADMIN"), async (c) => {
  const data = menuItemSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const item = await createMenuItem(pool, data);
  await sseService.broadcastMenuUpdate(getBindings(c));
  return c.json(item, 201);
});

adminMenuRouter.patch("/menu-items/:id", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const data = menuItemUpdateSchema.parse(await c.req.json());
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  const item = await updateMenuItem(pool, id, data, user.kitchen || undefined);
  await sseService.broadcastMenuUpdate(getBindings(c));
  return c.json(item);
});

adminMenuRouter.delete("/menu-items/:id", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  await deleteMenuItem(pool, id, user.kitchen || undefined);
  await logAction(pool, user.id, "MENU_ITEM_DELETE", "MenuItem", id);
  await sseService.broadcastMenuUpdate(getBindings(c));
  return c.body(null, 204);
});

// The real ceiling on request-body size is the `bodyLimit` middleware below,
// which streams the body and aborts as soon as MAX_UPLOAD_BODY_BYTES is
// exceeded — it never buffers more than that into memory, regardless of
// whether the client sends a Content-Length header at all (chunked transfer
// omits it) or lies about one (a garbage/absent header used to make the old
// header-only check here a no-op: Number(undefined) is NaN, and `NaN > x` is
// always false). The header check below is now just a coarse, cheap
// first-pass rejection for the common case where the header IS present and
// honest — it is not, and must never be treated as, a real security
// boundary; `bodyLimit` is that boundary. Sized generously above
// MAX_STORED_IMAGE_BYTES so a client's WebP/JPEG fallback choice never trips
// either check before the real, precise byte-length + dimension checks
// inside uploadMenuItemImage run.
const MAX_UPLOAD_BODY_BYTES = 1024 * 1024; // headroom over MAX_STORED_IMAGE_BYTES (512KB) for multipart framing overhead

adminMenuRouter.post(
  "/menu-items/:id/image",
  requireAuth("ADMIN"),
  rateLimit({ prefix: "image-upload", windowSeconds: 60, max: 10, code: "TOO_MANY_UPLOADS", message: "Too many image uploads, please slow down." }),
  bodyLimit({
    maxSize: MAX_UPLOAD_BODY_BYTES,
    onError: () => {
      throw new ApiError(413, "IMAGE_TOO_LARGE", "Upload too large.");
    },
  }),
  async (c) => {
    const id = idParamSchema.parse(c.req.param("id"));
    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_STORED_IMAGE_BYTES * 2) {
      throw new ApiError(413, "IMAGE_TOO_LARGE", "Upload too large.");
    }

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw new ApiError(400, "INVALID_IMAGE", "Missing image file.");

    const pool = getRequestPool(c);
    const user = c.get("user")!;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await uploadMenuItemImage(pool, {
      menuItemId: id,
      bytes,
      declaredType: file.type,
      uploadedById: user.id,
      adminKitchen: user.kitchen || undefined,
    });
    await logAction(pool, user.id, "MENU_ITEM_IMAGE_UPLOAD", "MenuItem", id);
    await sseService.broadcastMenuUpdate(getBindings(c));
    return c.json(result, 200);
  }
);

/**
 * Outstanding "tell me when it's back" demand, grouped by item. Kitchen admins
 * see only their own kitchen; an unscoped admin sees everything.
 */
adminMenuRouter.get("/stock-requests", requireAuth("ADMIN"), async (c) => {
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  return c.json({ requests: await listStockRequests(pool, user.kitchen) });
});

/**
 * Tells everyone waiting on an item that it is back, then clears the round.
 *
 * Reports reachability rather than just a success count: students who never
 * linked Telegram cannot be messaged, and the admin should see that instead of
 * being told everyone was notified.
 */
adminMenuRouter.post("/stock-requests/:id/notify", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const pool = getRequestPool(c);
  const user = c.get("user")!;

  const result = await notifyRestocked(pool, getBindings(c), id, user.kitchen);
  await logAction(pool, user.id, "STOCK_REQUEST_NOTIFY", "MenuItem", id, {
    notified: result.notified,
    unreachable: result.unreachable,
    cleared: result.cleared,
  });
  return c.json(result);
});

adminMenuRouter.delete("/menu-items/:id/image", requireAuth("ADMIN"), async (c) => {
  const id = idParamSchema.parse(c.req.param("id"));
  const pool = getRequestPool(c);
  const user = c.get("user")!;
  await deleteMenuItemImage(pool, id, user.kitchen || undefined);
  await logAction(pool, user.id, "MENU_ITEM_IMAGE_DELETE", "MenuItem", id);
  await sseService.broadcastMenuUpdate(getBindings(c));
  return c.body(null, 204);
});
