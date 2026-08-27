import { Hono } from "hono";
import { getCategorizedMenu } from "../services/menuService.js";
import * as menuItemRepo from "../db/menuItemRepo.js";
import * as menuItemImageRepo from "../db/menuItemImageRepo.js";
import { getRequestPool, getBindings } from "../lib/context.js";
import { getHttpSql } from "../lib/db.js";
import type { AppEnv } from "../types.js";

export const menuRouter = new Hono<AppEnv>();

// The single most-hit read in the app (every page load, every role). Neither
// Category nor MenuItem has a `timestamp` column, so this is exempt from the
// TIMESTAMP-type-parser caveat on getHttpSql() (lib/db.ts) — the one thing
// that keeps the rest of this codebase's reads on Pool for now. No socket
// handshake per request the way Pool needs on Workers (see lib/db.ts).
menuRouter.get("/", async (c) => {
  const kitchen = c.req.query("kitchen");
  const isAdmin = c.req.query("admin") === "true";
  const httpSql = getHttpSql(getBindings(c).DATABASE_URL);
  const menu = await getCategorizedMenu(httpSql, kitchen, isAdmin);
  return c.json(menu);
});

const HASH_RE = /^[0-9a-f]{32}$/;

/**
 * Public, unauthenticated — an <img> tag cannot send an Authorization
 * header. Content is public product photography; the only thing exposed is
 * a menu-item UUID, which GET /menu already returns to anonymous callers.
 *
 * The URL is content-addressed (:hash = MenuItem.imageHash), so a fixed
 * (id, hash) pair is byte-identical forever or 404 — that guarantee is what
 * licenses the `immutable` cache directive below. Checking the Cache API
 * BEFORE touching the DB matters: it's what keeps a cache hit from paying
 * for a fresh Neon connection (this backend opens one Pool per request on
 * Workers). Cloudflare's Cache API is a no-op on *.workers.dev — this only
 * saves a DB round trip once the API is on a custom domain.
 *
 * Menu item UUIDs are public (GET /menu returns them to anyone), so an
 * attacker can loop random 32-hex-char hash guesses against a real item id.
 * This route is deliberately NOT IP-rate-limited (see rateLimit.ts's
 * file-header comment — campus WiFi NATs the whole student body behind one
 * IP, so an IP-keyed limit here would do nothing or punish innocent
 * students; true volumetric protection for anonymous traffic belongs at
 * Cloudflare's edge, not here). What this route DOES control is cost per
 * guess: `menuItemRepo.findMenuItemById` fetches only the small `imageHash`
 * column (no `bytes`) and is checked against the URL's `:hash` FIRST. Only a
 * correct guess ever proceeds to `findImage()`, which pulls the full (up to
 * 512KB) `bytes` column. Because `MenuItem.imageHash` is written atomically
 * with the `MenuItemImage` row in the same transaction (see
 * menuItemImageRepo.ts's putImage/deleteImage), a match here already
 * guarantees the bytes fetched next are current — no need to re-hash them
 * after the fetch.
 */
menuRouter.get("/items/:id/image/:hash", async (c) => {
  const id = c.req.param("id");
  const hash = c.req.param("hash");
  if (!HASH_RE.test(hash)) return c.body(null, 404);

  const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
  if (cache) {
    const cached = await cache.match(c.req.raw);
    if (cached) return cached;
  }

  const pool = getRequestPool(c);

  // Cheap check first: a small, indexed lookup instead of a 512KB fetch for
  // every wrong-hash guess.
  const item = await menuItemRepo.findMenuItemById(pool, id);
  if (!item || item.imageHash !== hash) return c.body(null, 404);

  const image = await menuItemImageRepo.findImage(pool, id);
  if (!image || image.menuItemId !== id) return c.body(null, 404);

  const res = new Response(image.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": image.mimeType,
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${hash}"`,
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      // Overrides the app-wide secureHeaders() same-origin default — this
      // route is loaded cross-origin, from an <img src> on the frontend's
      // own domain.
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });

  if (cache) c.executionCtx?.waitUntil(cache.put(c.req.raw, res.clone()));
  return res;
});
