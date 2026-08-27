import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

import { describeDb, getTestPool, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { startTestServer, closeTestServer, createAdmin, createStudent, createMenuItem, tokenFor } from "./helpers/app.js";
import { sql, query } from "../src/db/sql.js";
import { MAX_STORED_IMAGE_BYTES } from "../src/services/menuImageService.js";
import * as menuItemImageRepo from "../src/db/menuItemImageRepo.js";
import { buildMinimalWebpLossy, buildMinimalJpeg, buildWebpExtended } from "./helpers/images.js";
import type { MenuItem } from "../src/db/schema.js";

// The database is reached ONLY through tests/helpers/db.ts, which refuses to
// hand out a client until tests/setup/vitest.setup.ts has proved the target is
// a disposable test database. `describeDb` skips (loudly) when none is
// configured — it never falls back to .env. See TESTING.md.
const pool = testDb.enabled ? getTestPool() : (undefined as any);
const server = testDb.enabled ? await startTestServer() : (undefined as any);

beforeEach(async () => {
  if (testDb.enabled) await resetDatabase();
});

afterAll(async () => {
  if (!testDb.enabled) return;
  await disconnectTestPrisma();
  await closeTestServer(server);
});

async function fetchImageHash(menuItemId: string): Promise<string | null> {
  const { rows } = await query<MenuItem>(pool, sql`SELECT "imageHash" FROM "MenuItem" WHERE "id" = ${menuItemId}`);
  return rows[0]?.imageHash ?? null;
}

describeDb("POST /admin/menu-items/:id/image", () => {
  it("uploads a valid WebP, then serves it back byte-for-byte at the returned hash", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const webp = Buffer.from(buildMinimalWebpLossy(200, 150));

    const uploadRes = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", webp, { filename: "photo.webp", contentType: "image/webp" });

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body).toMatchObject({
      mimeType: "image/webp",
      width: 200,
      height: 150,
      byteSize: webp.byteLength,
    });
    expect(uploadRes.body.imageHash).toMatch(/^[0-9a-f]{32}$/);

    // MenuItem.imageHash is stamped in the same transaction as the write.
    expect(await fetchImageHash(item.id)).toBe(uploadRes.body.imageHash);

    const getRes = await request(server).get(`/menu/items/${item.id}/image/${uploadRes.body.imageHash}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers["content-type"]).toBe("image/webp");
    // Loaded cross-origin from an <img src> on the frontend's own domain —
    // regressing this silently breaks every product photo on the site.
    expect(getRes.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(Buffer.compare(getRes.body, webp)).toBe(0);
  });

  it("rejects an unauthenticated request", async () => {
    const item = await createMenuItem();
    const webp = Buffer.from(buildMinimalWebpLossy(100, 100));

    const res = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .attach("file", webp, { filename: "photo.webp", contentType: "image/webp" });

    expect(res.status).toBe(401);
  });

  it("rejects a non-admin (student) with 403", async () => {
    const student = await createStudent();
    const token = tokenFor(student);
    const item = await createMenuItem();
    const webp = Buffer.from(buildMinimalWebpLossy(100, 100));

    const res = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", webp, { filename: "photo.webp", contentType: "image/webp" });

    expect(res.status).toBe(403);
  });

  it("rejects an admin from the wrong kitchen with 403 INVALID_KITCHEN", async () => {
    const admin = await createAdmin({ kitchen: "MEALS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const webp = Buffer.from(buildMinimalWebpLossy(100, 100));

    const res = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", webp, { filename: "photo.webp", contentType: "image/webp" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("INVALID_KITCHEN");
    expect(await fetchImageHash(item.id)).toBeNull();
  });

  it("rejects a file over 512KB with 413", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    // Content past MAX_STORED_IMAGE_BYTES is rejected on size before it is
    // ever sniffed, so the bytes need not be a valid image.
    const oversized = Buffer.alloc(MAX_STORED_IMAGE_BYTES + 1024, 0x41);

    const res = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", oversized, { filename: "big.webp", contentType: "image/webp" });

    expect(res.status).toBe(413);
    expect(await fetchImageHash(item.id)).toBeNull();
  });

  it("rejects bytes that don't sniff as a JPEG or WebP with 400", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const notAnImage = Buffer.from("this is definitely not an image file");

    const res = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", notAnImage, { filename: "fake.webp", contentType: "image/webp" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_IMAGE");
  });

  it("rejects when the declared content type doesn't match the sniffed format", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    // Real JPEG bytes, declared as WebP.
    const jpeg = Buffer.from(buildMinimalJpeg(100, 100));

    const res = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", jpeg, { filename: "mislabeled.webp", contentType: "image/webp" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_IMAGE");
  });

  it("rejects an image whose claimed dimensions exceed 2048px", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const huge = Buffer.from(buildWebpExtended(3000, 3000));

    const res = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", huge, { filename: "huge.webp", contentType: "image/webp" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_IMAGE");
  });

  it("rejects a JPEG with zero width/height (a crafted minimal header) with 400, not a raw DB CHECK 500", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const zeroDim = Buffer.from(buildMinimalJpeg(0, 0));

    const res = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", zeroDim, { filename: "zero.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_IMAGE");
    expect(await fetchImageHash(item.id)).toBeNull();
  });

  it("rejects a WebP with zero width/height with 400, not a raw DB CHECK 500", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const zeroDim = Buffer.from(buildWebpExtended(0, 0));

    const res = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", zeroDim, { filename: "zero.webp", contentType: "image/webp" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_IMAGE");
    expect(await fetchImageHash(item.id)).toBeNull();
  });

  it("rejects an animated WebP (VP8X Animation flag set) with 400", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const animated = Buffer.from(buildWebpExtended(200, 150, { animated: true }));

    const res = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", animated, { filename: "animated.webp", contentType: "image/webp" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_IMAGE");
  });

  it("rejects a request body larger than the bodyLimit ceiling with 413, before it is ever buffered/parsed", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    // Comfortably past the 1MB bodyLimit ceiling — bodyLimit rejects this
    // while streaming, well before parseBody() or the 512KB image check runs.
    const oversized = Buffer.alloc(2 * 1024 * 1024, 0x41);

    const res = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", oversized, { filename: "big.webp", contentType: "image/webp" });

    expect(res.status).toBe(413);
    expect(await fetchImageHash(item.id)).toBeNull();
  });

  it("returns 404 end-to-end (not a raw FK-violation 500) when the menu item no longer exists at upload time", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const webp = Buffer.from(buildMinimalWebpLossy(64, 64));

    await query(pool, sql`DELETE FROM "MenuItem" WHERE "id" = ${item.id}`);

    const res = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", webp, { filename: "photo.webp", contentType: "image/webp" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describeDb("menuItemImageRepo — FOR UPDATE lock and existence check (findings 6/8)", () => {
  it("putImage throws a clean 404, not a raw FK violation, when the target MenuItem doesn't exist", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000000";
    const webp = buildMinimalWebpLossy(64, 64);

    await expect(
      menuItemImageRepo.putImage(pool, {
        menuItemId: nonExistentId,
        bytes: webp,
        mimeType: "image/webp",
        hash: "a".repeat(32),
        width: 64,
        height: 64,
        uploadedById: (await createAdmin({ kitchen: "SNACKS" })).id,
      })
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("deleteImage throws a clean 404 when the target MenuItem doesn't exist", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000000";
    await expect(menuItemImageRepo.deleteImage(pool, nonExistentId)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it(
    "concurrent putImage + deleteImage on an item with no prior image never leaves orphaned bytes with a NULL imageHash",
    async () => {
      // Regression test for the pre-fix race: a DELETE matching zero
      // MenuItemImage rows took no lock, so a concurrent putImage's INSERT +
      // imageHash UPDATE could commit in between the DELETE's own two
      // statements, leaving real bytes with imageHash left NULL. Both
      // functions now take a FOR UPDATE lock on the parent MenuItem row
      // first, which serializes them regardless of arrival order — so
      // whichever operation's transaction commits last should always leave
      // the DB in a materialized single result state, not a spliced one.
      const admin = await createAdmin({ kitchen: "SNACKS" });
      const item = await createMenuItem({ kitchen: "SNACKS" });
      const webp = buildMinimalWebpLossy(64, 64);

      await Promise.allSettled([
        menuItemImageRepo.putImage(pool, {
          menuItemId: item.id,
          bytes: webp,
          mimeType: "image/webp",
          hash: "b".repeat(32),
          width: 64,
          height: 64,
          uploadedById: admin.id,
        }),
        menuItemImageRepo.deleteImage(pool, item.id),
      ]);

      const { rows } = await query<MenuItem>(pool, sql`SELECT "imageHash" FROM "MenuItem" WHERE "id" = ${item.id}`);
      const hash = rows[0]?.imageHash ?? null;
      const image = await menuItemImageRepo.findImage(pool, item.id);

      // The invariant menuItemImageRepo.ts documents: imageHash IS NOT NULL
      // must always mean a matching MenuItemImage row exists, and vice versa.
      // Whichever operation "won" the serialized race, this must hold.
      if (hash === null) {
        expect(image).toBeNull();
      } else {
        expect(image).not.toBeNull();
        expect(image!.menuItemId).toBe(item.id);
      }
    }
  );
});

describeDb("GET /menu/items/:id/image/:hash", () => {
  it("404s on a wrong/stale hash rather than serving the current bytes", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const webp = Buffer.from(buildMinimalWebpLossy(64, 64));

    const uploadRes = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", webp, { filename: "photo.webp", contentType: "image/webp" });
    expect(uploadRes.status).toBe(200);

    const staleHash = "0".repeat(32);
    expect(staleHash).not.toBe(uploadRes.body.imageHash);

    const res = await request(server).get(`/menu/items/${item.id}/image/${staleHash}`);
    expect(res.status).toBe(404);
  });

  it("404s on a malformed hash segment", async () => {
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const res = await request(server).get(`/menu/items/${item.id}/image/not-a-hash`);
    expect(res.status).toBe(404);
  });

  it("404s when no image has ever been uploaded", async () => {
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const res = await request(server).get(`/menu/items/${item.id}/image/${"a".repeat(32)}`);
    expect(res.status).toBe(404);
  });

  it("a wrong hash guess against a real item never touches MenuItemImage's bytes column", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const webp = Buffer.from(buildMinimalWebpLossy(64, 64));

    const uploadRes = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", webp, { filename: "photo.webp", contentType: "image/webp" });
    expect(uploadRes.status).toBe(200);

    const findImageSpy = vi.spyOn(menuItemImageRepo, "findImage");
    try {
      const wrongHash = "f".repeat(32);
      expect(wrongHash).not.toBe(uploadRes.body.imageHash);

      const res = await request(server).get(`/menu/items/${item.id}/image/${wrongHash}`);
      expect(res.status).toBe(404);

      // The cheap MenuItem.imageHash check must reject this before ever
      // calling findImage() (which SELECTs the full up-to-512KB bytes column).
      expect(findImageSpy).not.toHaveBeenCalled();
    } finally {
      findImageSpy.mockRestore();
    }
  });

  it("a correct hash still calls findImage() exactly once and serves the bytes", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const webp = Buffer.from(buildMinimalWebpLossy(64, 64));

    const uploadRes = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", webp, { filename: "photo.webp", contentType: "image/webp" });
    expect(uploadRes.status).toBe(200);

    const findImageSpy = vi.spyOn(menuItemImageRepo, "findImage");
    try {
      const res = await request(server).get(`/menu/items/${item.id}/image/${uploadRes.body.imageHash}`);
      expect(res.status).toBe(200);
      expect(findImageSpy).toHaveBeenCalledTimes(1);
    } finally {
      findImageSpy.mockRestore();
    }
  });
});

describeDb("DELETE /admin/menu-items/:id/image", () => {
  it("removes the image and nulls MenuItem.imageHash", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const token = tokenFor(admin);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const webp = Buffer.from(buildMinimalWebpLossy(64, 64));

    const uploadRes = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", webp, { filename: "photo.webp", contentType: "image/webp" });
    expect(uploadRes.status).toBe(200);
    const hash = uploadRes.body.imageHash;

    const deleteRes = await request(server)
      .delete(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${token}`);
    expect(deleteRes.status).toBe(204);

    expect(await fetchImageHash(item.id)).toBeNull();

    const getRes = await request(server).get(`/menu/items/${item.id}/image/${hash}`);
    expect(getRes.status).toBe(404);

    const adminMenuRes = await request(server)
      .get("/menu?admin=true")
      .set("Authorization", `Bearer ${token}`);
    const found = adminMenuRes.body.categories
      .flatMap((c: any) => c.items)
      .find((i: any) => i.id === item.id);
    expect(found).toBeDefined();
    expect(found.imageHash).toBeNull();
  });

  it("rejects an admin from the wrong kitchen with 403 INVALID_KITCHEN and leaves the image intact", async () => {
    const owner = await createAdmin({ kitchen: "SNACKS" });
    const ownerToken = tokenFor(owner);
    const item = await createMenuItem({ kitchen: "SNACKS" });
    const webp = Buffer.from(buildMinimalWebpLossy(64, 64));
    const uploadRes = await request(server)
      .post(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("file", webp, { filename: "photo.webp", contentType: "image/webp" });
    expect(uploadRes.status).toBe(200);

    const outsider = await createAdmin({ kitchen: "MEALS" });
    const outsiderToken = tokenFor(outsider);

    const res = await request(server)
      .delete(`/admin/menu-items/${item.id}/image`)
      .set("Authorization", `Bearer ${outsiderToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("INVALID_KITCHEN");
    expect(await fetchImageHash(item.id)).toBe(uploadRes.body.imageHash);
  });
});
