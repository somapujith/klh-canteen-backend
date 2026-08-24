import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { signOrderToken } from "../lib/orderToken.js";
import { qrDataUrl } from "../lib/qr.js";
import { ApiError } from "../middleware/errorHandler.js";

/**
 * Who an order belongs to. EXACTLY ONE of these two shapes, never both and
 * never neither — see assertSingleOwner() and the Order model doc comment.
 */
export interface StudentOwner {
  studentId: string;
}

export interface GuestOwner {
  /** Recovered from a verified guest session token — never client-supplied. */
  guestSessionId: string;
  guestName?: string | null;
  guestPhone?: string | null;
}

export type OrderOwner = StudentOwner | GuestOwner;

interface CreateOrderInput {
  owner: OrderOwner;
  items: { menuItemId: string; qty: number }[];
  /**
   * Requested collection time. Undefined/null keeps the original behaviour:
   * cook it as soon as possible. Any value is floored to its slot start and
   * must win a seat in that slot's capacity ledger.
   */
  collectionAt?: Date | null;
}

/**
 * Identity fields an admin needs to recognise who placed an order. Explicit,
 * because `student: true` returns the whole User row — passwordHash included.
 */
const STUDENT_SUMMARY = { select: { id: true, name: true, rollNumber: true, email: true } } as const;

/**
 * Everything an admin view needs. `student` is nullable now that guests can
 * order, so it is never enough on its own — see withCustomer().
 */
const ADMIN_ORDER_INCLUDE = {
  items: { include: { menuItem: true } },
  student: STUDENT_SUMMARY,
} as const;

// ---------------------------------------------------------------------------
// Owner invariant
// ---------------------------------------------------------------------------

function isGuestOwner(owner: OrderOwner): owner is GuestOwner {
  return "guestSessionId" in owner;
}

/**
 * An order is student-owned OR guest-owned. Enforced here because Postgres
 * cannot express "exactly one of these two columns is non-null" through
 * Prisma's schema language, and because every read path downstream — student
 * scoping, guest scoping, the kitchen board's "who is this for" column —
 * assumes it holds. Both-set would make an order readable by two unrelated
 * parties; neither-set would make it readable by no one and unattributable
 * on the board.
 */
function assertSingleOwner(owner: OrderOwner): void {
  const studentId = (owner as Partial<StudentOwner>).studentId;
  const guestSessionId = (owner as Partial<GuestOwner>).guestSessionId;

  if (studentId && guestSessionId) {
    throw new ApiError(400, "AMBIGUOUS_ORDER_OWNER", "An order cannot belong to both a student and a guest");
  }
  if (!studentId && !guestSessionId) {
    throw new ApiError(400, "MISSING_ORDER_OWNER", "An order must belong to either a student or a guest session");
  }
}

/**
 * Normalised "who is this order for", present on every admin-facing order.
 *
 * The kitchen board must always be able to name an order's owner, and
 * `student` alone can no longer do that — it is null for every guest order.
 * Rather than making each caller branch, admin reads carry this field with
 * the guest's details standing in when there is no student behind the order.
 * `student` is still returned untouched for existing clients.
 */
export type OrderCustomer = {
  type: "STUDENT" | "GUEST";
  id: string | null;
  name: string;
  rollNumber: string | null;
  phone: string | null;
};

type CustomerSource = {
  student?: { id: string; name: string; rollNumber: string | null } | null;
  guestSessionId?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
};

export function withCustomer<T extends CustomerSource>(order: T): T & { customer: OrderCustomer } {
  const customer: OrderCustomer = order.student
    ? {
        type: "STUDENT",
        id: order.student.id,
        name: order.student.name,
        rollNumber: order.student.rollNumber ?? null,
        phone: null,
      }
    : {
        type: "GUEST",
        // The session id is an ownership key, not a public identifier, so it
        // is deliberately NOT leaked here. Admins get a label, not a handle.
        id: null,
        name: order.guestName?.trim() || "Guest",
        rollNumber: null,
        phone: order.guestPhone ?? null,
      };
  return { ...order, customer };
}

// ---------------------------------------------------------------------------
// Stock reservation
// ---------------------------------------------------------------------------

/**
 * Anything that can run a raw statement — the client itself or a transaction
 * handle. The reservation primitives deliberately do not require a
 * transaction: their whole point is that each one is atomic on its own.
 */
type RawRunner = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

/** How long an "as soon as possible" order holds its portions. */
export const RESERVATION_TTL_MS = 4 * 60 * 60 * 1000;
/** Grace after a pre-booked collection time before the portions go back. */
export const PREBOOK_RESERVATION_GRACE_MS = 2 * 60 * 60 * 1000;
/** Expiry sweeps are housekeeping, so at most one per minute per isolate. */
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000;
/** Full rebuilds scan every order item, so they run far less often. */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

let nextExpirySweepAt = 0;
let nextReconcileAt = 0;

export interface StockClaim {
  menuItemId: string;
  qty: number;
}

function claimValues(claims: StockClaim[]) {
  return Prisma.join(claims.map((c) => Prisma.sql`(${c.menuItemId}::text, ${c.qty}::int)`));
}

/**
 * Claims portions for a whole basket in ONE conditional UPDATE.
 *
 * `stockQty - reservedQty >= qty` lives in the WHERE clause, so Postgres
 * evaluates it while holding the row lock it took for the update, against the
 * committed value — and simply does not update a row that would go negative.
 * The returned ids are therefore the definitive list of what was claimed:
 * a caller compares that count to what it asked for, and if the two differ it
 * hands back the rows that did succeed. This is the same shape the collection
 * window ceiling has always used.
 *
 * What this deliberately is NOT: a SELECT ... FOR UPDATE followed by a write.
 * That pattern held shared MenuItem rows locked across every remaining round
 * trip of the order transaction, which is what made 25 concurrent baskets for
 * a popular item serialise into a 13-second tail.
 */
async function claimStock(db: RawRunner, claims: StockClaim[]): Promise<Set<string>> {
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE "MenuItem" m
       SET "reservedQty" = m."reservedQty" + r.qty
      FROM (VALUES ${claimValues(claims)}) AS r(id, qty)
     WHERE m.id = r.id
       AND m."isAvailable" = TRUE
       AND m."stockQty" - m."reservedQty" >= r.qty
    RETURNING m.id
  `;
  return new Set(claimed.map((row) => row.id));
}

/**
 * Hands portions back. GREATEST(0, ...) is a floor, not a guess: reservedQty
 * must never go negative, because a negative reservation would silently
 * inflate what the next basket is allowed to claim.
 */
async function releaseStock(db: RawRunner, claims: StockClaim[]): Promise<void> {
  if (claims.length === 0) return;
  await db.$executeRaw`
    UPDATE "MenuItem" m
       SET "reservedQty" = GREATEST(0, m."reservedQty" - r.qty)
      FROM (VALUES ${claimValues(claims)}) AS r(id, qty)
     WHERE m.id = r.id
  `;
}

/**
 * Gives one order's reservation back, idempotently.
 *
 * The `settled` CTE is the gate: it stamps `stockSettledAt` only if the order
 * still holds a reservation, and the give-back joins off its RETURNING. A
 * second cancel, or a cancel racing the expiry sweeper, updates zero rows in
 * `settled` and therefore moves no stock. Returns true if this call was the
 * one that released it.
 */
export async function releaseOrderReservation(db: RawRunner, orderId: string): Promise<boolean> {
  const released = await db.$queryRaw<{ id: string }[]>`
    WITH settled AS (
      UPDATE "Order"
         SET "stockSettledAt" = NOW()
       WHERE "id" = ${orderId}::text
         AND "reservedAt" IS NOT NULL
         AND "stockSettledAt" IS NULL
      RETURNING "id"
    ), give_back AS (
      SELECT oi."menuItemId" AS mid, SUM(oi."quantity")::int AS qty
        FROM "OrderItem" oi
        JOIN settled s ON s."id" = oi."orderId"
       GROUP BY oi."menuItemId"
    ), moved AS (
      UPDATE "MenuItem" m
         SET "reservedQty" = GREATEST(0, m."reservedQty" - g.qty)
        FROM give_back g
       WHERE m."id" = g.mid
      RETURNING m."id"
    )
    SELECT "id" FROM settled
  `;
  return released.length > 0;
}

/**
 * Returns the portions held by orders that were placed and then never
 * happened — nobody collected them, nobody cooked them, and their deadline
 * has passed. Without this, one abandoned basket would tie up a portion for
 * the rest of the term and the number students see would drift downwards
 * forever.
 *
 * DELIVERED orders are excluded because their reservation was already turned
 * into a real stock decrement.
 */
export async function releaseExpiredReservations(db: RawRunner): Promise<number> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH settled AS (
      UPDATE "Order"
         SET "stockSettledAt" = NOW()
       WHERE "reservedAt" IS NOT NULL
         AND "stockSettledAt" IS NULL
         AND "reservationExpiresAt" IS NOT NULL
         AND "reservationExpiresAt" < NOW()
         AND "status" <> 'DELIVERED'::"OrderStatus"
      RETURNING "id"
    ), give_back AS (
      SELECT oi."menuItemId" AS mid, SUM(oi."quantity")::int AS qty
        FROM "OrderItem" oi
        JOIN settled s ON s."id" = oi."orderId"
       GROUP BY oi."menuItemId"
    ), moved AS (
      UPDATE "MenuItem" m
         SET "reservedQty" = GREATEST(0, m."reservedQty" - g.qty)
        FROM give_back g
       WHERE m."id" = g.mid
      RETURNING m."id"
    )
    SELECT "id" FROM settled
  `;
  return rows.length;
}

/**
 * Rebuilds `MenuItem.reservedQty` from the order ledger.
 *
 * `reservedQty` is a cache; the truth is "sum the items of every order that
 * has claimed stock and not yet settled it". The two can only diverge one
 * way: a worker that claims stock and is then killed before its order row is
 * written leaves portions held by nothing. Nothing in the request path can
 * repair that — the evidence died with the request — so a periodic rebuild
 * does, and stock cannot be stranded permanently by a crash.
 *
 * Returns the number of items whose cached value was wrong.
 */
export async function reconcileReservations(db: RawRunner): Promise<number> {
  return db.$executeRaw`
    UPDATE "MenuItem" m
       SET "reservedQty" = t.qty
      FROM (
        SELECT mi."id" AS id,
               COALESCE(SUM(CASE WHEN o."id" IS NULL THEN 0 ELSE oi."quantity" END), 0)::int AS qty
          FROM "MenuItem" mi
          LEFT JOIN "OrderItem" oi ON oi."menuItemId" = mi."id"
          LEFT JOIN "Order" o ON o."id" = oi."orderId"
                             AND o."reservedAt" IS NOT NULL
                             AND o."stockSettledAt" IS NULL
         GROUP BY mi."id"
      ) t
     WHERE m."id" = t.id
       AND m."reservedQty" <> t.qty
  `;
}

/**
 * Housekeeping, run from the READ paths only.
 *
 * Deliberately never called from createOrder: the write path is the measured
 * bottleneck and nothing that is not a student's order belongs in it. The
 * board and the student order list are polled constantly, so a self-throttled
 * hook there runs often enough without ever standing between a hungry student
 * and their order. Errors are logged and swallowed — a failed sweep is stale
 * housekeeping, and must not turn somebody's order list into a 500.
 */
export async function sweepReservations(db: RawRunner, options: { force?: boolean } = {}): Promise<void> {
  const now = Date.now();
  const doExpiry = options.force || now >= nextExpirySweepAt;
  const doReconcile = options.force || now >= nextReconcileAt;
  if (!doExpiry && !doReconcile) return;

  // Stamped before the work, not after, so a failing sweep backs off instead
  // of being retried by every request that arrives while it is broken.
  if (doExpiry) nextExpirySweepAt = now + EXPIRY_SWEEP_INTERVAL_MS;
  if (doReconcile) nextReconcileAt = now + RECONCILE_INTERVAL_MS;

  try {
    if (doExpiry) await releaseExpiredReservations(db);
    if (doReconcile) await reconcileReservations(db);
  } catch (err) {
    console.warn("[orders] reservation sweep failed", err);
  }
}

// ---------------------------------------------------------------------------
// Pre-booking: collection windows
// ---------------------------------------------------------------------------

/** Slot granularity. A collection time is always floored to a slot start. */
export const COLLECTION_SLOT_MINUTES = 15;
/** How far ahead a student may pre-book. */
export const MAX_PREBOOK_DAYS = 7;
/** Orders one kitchen accepts per slot, until an admin raises a given row. */
export const DEFAULT_WINDOW_CAPACITY = 20;

/** Floors an instant to the start of its collection slot. */
export function normaliseCollectionSlot(requested: Date): Date {
  const ms = COLLECTION_SLOT_MINUTES * 60 * 1000;
  return new Date(Math.floor(requested.getTime() / ms) * ms);
}

/**
 * Validates a requested collection time and returns its slot start.
 * Returns null for "as soon as possible", which is what every existing
 * client sends (i.e. nothing at all).
 */
export function resolveCollectionSlot(requested?: Date | null): Date | null {
  if (requested === undefined || requested === null) return null;
  if (Number.isNaN(requested.getTime())) {
    throw new ApiError(400, "INVALID_COLLECTION_WINDOW", "Collection time is not a valid date");
  }

  const slot = normaliseCollectionSlot(requested);
  const currentSlot = normaliseCollectionSlot(new Date());
  if (slot.getTime() < currentSlot.getTime()) {
    throw new ApiError(400, "COLLECTION_WINDOW_PAST", "That collection time has already passed");
  }

  const horizon = Date.now() + MAX_PREBOOK_DAYS * 24 * 60 * 60 * 1000;
  if (slot.getTime() > horizon) {
    throw new ApiError(
      400,
      "COLLECTION_WINDOW_TOO_FAR",
      `Orders can be pre-booked at most ${MAX_PREBOOK_DAYS} days ahead`,
    );
  }
  return slot;
}

/**
 * Claims one seat per kitchen in a collection window, creating the ledger row
 * on first use.
 *
 * ONE statement for the whole cart. `ON CONFLICT ... DO UPDATE ... WHERE` is
 * the same conditional-increment shape used for stock: Postgres takes the row
 * lock, re-evaluates `bookedCount < capacity` against the committed value, and
 * returns nothing for a window that is already full. A read-then-write would
 * let two concurrent bookings both observe 19/20 and both commit.
 *
 * Returns the kitchens that actually got a seat, so the caller can tell a
 * partial claim from a complete one and hand the rest back.
 */
async function claimWindowSeats(db: RawRunner, slot: Date, kitchens: string[]): Promise<Set<string>> {
  const rows = Prisma.join(
    kitchens.map((kitchen) => Prisma.sql`(${crypto.randomUUID()}::text, ${kitchen}::text)`),
  );
  const claimed = await db.$queryRaw<{ kitchen: string }[]>`
    INSERT INTO "CollectionWindow" ("id", "startAt", "kitchen", "capacity", "bookedCount", "createdAt")
    SELECT v.id, ${slot.toISOString()}::timestamp, v.kitchen::"Kitchen", ${DEFAULT_WINDOW_CAPACITY}::int, 1, NOW()
      FROM (VALUES ${rows}) AS v(id, kitchen)
    ON CONFLICT ("startAt", "kitchen") DO UPDATE
       SET "bookedCount" = "CollectionWindow"."bookedCount" + 1
     WHERE "CollectionWindow"."bookedCount" < "CollectionWindow"."capacity"
    RETURNING "kitchen"::text AS kitchen
  `;
  return new Set(claimed.map((row) => row.kitchen));
}

/** Hands seats back after a claim that could not be completed. */
async function releaseWindowSeats(db: RawRunner, slot: Date, kitchens: string[]): Promise<void> {
  if (kitchens.length === 0) return;
  await db.$executeRaw`
    UPDATE "CollectionWindow"
       SET "bookedCount" = GREATEST(0, "bookedCount" - 1)
     WHERE "startAt" = ${slot.toISOString()}::timestamp
       AND "kitchen"::text = ANY(${kitchens}::text[])
  `;
}

/**
 * Remaining capacity per slot for a kitchen, so a client can grey out full
 * windows instead of discovering them at checkout. Slots with no ledger row
 * yet are simply absent — they are empty by definition.
 */
export async function getCollectionWindows(prisma: PrismaClient, kitchen: string, from: Date, to: Date) {
  const rows = await prisma.collectionWindow.findMany({
    where: { kitchen: kitchen as any, startAt: { gte: from, lte: to } },
    orderBy: { startAt: "asc" },
  });
  return rows.map((row) => ({
    startAt: row.startAt,
    kitchen: row.kitchen,
    capacity: row.capacity,
    bookedCount: row.bookedCount,
    remaining: Math.max(0, row.capacity - row.bookedCount),
    isFull: row.bookedCount >= row.capacity,
  }));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** One Postgres sequence per kitchen. Each kitchen calls its own numbers. */
const ORDER_NUMBER_SEQUENCE: Record<string, string> = {
  SNACKS: "order_number_snacks",
  MEALS: "order_number_meals",
};

interface OrderDraft {
  id: string;
  kitchen: string;
  token: string;
  totalAmount: string;
  lines: { id: string; menuItem: any; qty: number }[];
}

/**
 * Writes the whole cart — every order and every line item — in ONE statement.
 *
 * Three things were costing round trips to a database on the other side of an
 * ocean, and all three are gone:
 *
 *  - The order number. It used to come from an upsert-with-increment against
 *    a single OrderSequence row, so every order on campus queued behind one
 *    row lock held for the rest of the transaction. `nextval()` is
 *    non-transactional and takes no row lock at all, and evaluated inline in
 *    this INSERT it costs no round trip either.
 *  - The QR token. It only needs the order id, and we mint the id here, so
 *    the token is signed before the INSERT instead of by a second UPDATE
 *    afterwards.
 *  - The line items. A data-modifying CTE puts them in the same statement as
 *    their orders; the foreign key is checked at end of statement, by which
 *    point both CTEs have run.
 */
async function insertOrders(
  db: RawRunner,
  drafts: OrderDraft[],
  ownerData: { studentId: string | null; guestSessionId: string | null; guestName: string | null; guestPhone: string | null },
  slot: Date | null,
  reservedAt: Date,
  expiresAt: Date,
): Promise<Map<string, { orderNumber: number; createdAt: Date }>> {
  const orderRows = Prisma.join(
    drafts.map(
      (d) => Prisma.sql`(${d.id}::text, ${d.kitchen}::text, ${d.token}::text, ${ORDER_NUMBER_SEQUENCE[d.kitchen] ?? ORDER_NUMBER_SEQUENCE.SNACKS}::text, ${d.totalAmount}::text)`,
    ),
  );
  const itemRows = Prisma.join(
    drafts.flatMap((d) =>
      d.lines.map(
        (line) =>
          Prisma.sql`(${line.id}::text, ${d.id}::text, ${line.menuItem.id}::text, ${line.qty}::int, ${String(line.menuItem.price)}::text)`,
      ),
    ),
  );

  const inserted = await db.$queryRaw<{ id: string; orderNumber: number; createdAt: Date }[]>`
    WITH new_orders AS (
      INSERT INTO "Order" (
        "id", "studentId", "guestSessionId", "guestName", "guestPhone",
        "kitchen", "token", "orderNumber", "totalAmount",
        "collectionAt", "reservedAt", "reservationExpiresAt"
      )
      SELECT v.id,
             ${ownerData.studentId}::text,
             ${ownerData.guestSessionId}::text,
             ${ownerData.guestName}::text,
             ${ownerData.guestPhone}::text,
             v.kitchen::"Kitchen",
             v.token,
             nextval(v.seq::regclass)::int,
             v.total::numeric(10, 2),
             ${slot ? slot.toISOString() : null}::timestamp,
             ${reservedAt.toISOString()}::timestamp,
             ${expiresAt.toISOString()}::timestamp
        FROM (VALUES ${orderRows}) AS v(id, kitchen, token, seq, total)
      RETURNING "id", "orderNumber", "createdAt"
    ), new_items AS (
      INSERT INTO "OrderItem" ("id", "orderId", "menuItemId", "quantity", "priceAtOrder")
      SELECT w.id, w."orderId", w."menuItemId", w.qty, w.price::numeric(10, 2)
        FROM (VALUES ${itemRows}) AS w(id, "orderId", "menuItemId", qty, price)
      RETURNING "id"
    )
    SELECT "id", "orderNumber", "createdAt" FROM new_orders
  `;

  return new Map(inserted.map((row) => [row.id, { orderNumber: row.orderNumber, createdAt: row.createdAt }]));
}

/**
 * Places a cart.
 *
 * SHAPE OF THE HOT PATH, and why it looks like this. The old version opened
 * an interactive transaction and then made roughly ten sequential round trips
 * inside it — SELECT ... FOR UPDATE on shared MenuItem rows, a re-fetch, an
 * upsert against the one global sequence row, a nested create, an update to
 * attach the token — while holding locks on rows that every other student
 * ordering the same popular item also needed. Lock hold time was therefore
 * ten network round trips to another region, and 25 concurrent baskets simply
 * queued: p50 3.7s, p95 13.1s, timeouts once unthrottled.
 *
 * There is now no interactive transaction on this path at all. Two statements:
 *
 *   1. claim the stock (and, when pre-booking, the window seats)
 *   2. write the orders and their items
 *
 * Each is atomic on its own, so every row lock is held for the duration of a
 * single statement inside Postgres — microseconds — instead of across the
 * network. Concurrent baskets stop queueing behind each other entirely.
 *
 * All-or-nothing without a transaction comes from compensation: a claim that
 * only partly succeeded is handed straight back, and so is a claim whose
 * INSERT then failed. The one case compensation cannot cover is the worker
 * being killed between the two statements, which would leave portions held by
 * an order that was never written — that is what reconcileReservations()
 * repairs, by rebuilding reservedQty from the order ledger.
 *
 * Everything that does not need to be here has been moved out: menu prices
 * and the student's name are read before the first statement (in parallel,
 * one round trip), and QR rendering stays after the last one.
 */
export async function createOrder(
  prisma: PrismaClient,
  qrTokenSecret: string,
  { owner, items, collectionAt }: CreateOrderInput,
) {
  if (items.length === 0) throw new ApiError(400, "EMPTY_ORDER", "Order must have at least one item");
  assertSingleOwner(owner);

  // Validated before anything is claimed: a bad collection time is a client
  // error, and there is no reason to hold stock while discovering it.
  const slot = resolveCollectionSlot(collectionAt);

  // A cart may name the same item on two lines. Collapse first, so the claim
  // asks for the true total rather than two independently-passing halves.
  const wanted = new Map<string, number>();
  for (const line of items) {
    if (!Number.isInteger(line.qty) || line.qty < 1) {
      throw new ApiError(400, "INVALID_QUANTITY", "Item quantity must be a positive whole number");
    }
    wanted.set(line.menuItemId, (wanted.get(line.menuItemId) ?? 0) + line.qty);
  }
  const menuItemIds = [...wanted.keys()].sort();

  const ownerData = isGuestOwner(owner)
    ? {
        studentId: null,
        guestSessionId: owner.guestSessionId,
        guestName: owner.guestName?.trim() || null,
        guestPhone: owner.guestPhone?.trim() || null,
      }
    : { studentId: owner.studentId, guestSessionId: null, guestName: null, guestPhone: null };

  // Reference reads, outside the critical section and in parallel — one round
  // trip for both. Neither decides whether the order succeeds; prices are a
  // snapshot by definition and availability is settled by the claim below.
  // The student rides along because the realtime board delta has to be able
  // to name who placed the order.
  const [menuItems, student] = await Promise.all([
    prisma.menuItem.findMany({ where: { id: { in: menuItemIds } }, include: { category: true } }),
    ownerData.studentId
      ? prisma.user.findUnique({ where: { id: ownerData.studentId }, select: STUDENT_SUMMARY.select })
      : Promise.resolve(null),
  ]);

  const menuItemById = new Map(menuItems.map((item) => [item.id, item]));
  const missing = menuItemIds.filter((id) => !menuItemById.has(id));
  if (missing.length > 0) {
    throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for ${missing.join(", ")}`);
  }

  const claims: StockClaim[] = menuItemIds.map((id) => ({ menuItemId: id, qty: wanted.get(id)! }));

  // ---- statement 1: claim stock -------------------------------------------
  const claimed = await claimStock(prisma, claims);
  if (claimed.size !== claims.length) {
    const short = claims.filter((c) => !claimed.has(c.menuItemId));
    await releaseStock(prisma, claims.filter((c) => claimed.has(c.menuItemId)));
    const names = short.map((c) => menuItemById.get(c.menuItemId)?.name ?? c.menuItemId);
    throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for ${names.join(", ")}`);
  }

  // A cart spanning both kitchens becomes two orders, and each kitchen cooks
  // its own half, so each is numbered and seated on its own.
  const byKitchen = new Map<string, { menuItem: (typeof menuItems)[number]; qty: number }[]>();
  for (const id of menuItemIds) {
    const menuItem = menuItemById.get(id)!;
    const kitchen = menuItem.category.kitchen || "SNACKS";
    const bucket = byKitchen.get(kitchen) ?? [];
    bucket.push({ menuItem, qty: wanted.get(id)! });
    byKitchen.set(kitchen, bucket);
  }
  const kitchens = [...byKitchen.keys()];

  const reservedAt = new Date();
  const expiresAt = slot
    ? new Date(slot.getTime() + PREBOOK_RESERVATION_GRACE_MS)
    : new Date(reservedAt.getTime() + RESERVATION_TTL_MS);

  const drafts: OrderDraft[] = kitchens.map((kitchen) => {
    const id = crypto.randomUUID();
    const lines = byKitchen.get(kitchen)!;
    const total = lines.reduce((sum, line) => sum + Number(line.menuItem.price) * line.qty, 0);
    return {
      id,
      kitchen,
      token: signOrderToken(id, qrTokenSecret),
      totalAmount: total.toFixed(2),
      lines: lines.map((line) => ({ id: crypto.randomUUID(), menuItem: line.menuItem, qty: line.qty })),
    };
  });

  /**
   * The shape createOrder has always returned, rebuilt from what we already
   * hold instead of read back from the database. Nothing here needs a round
   * trip: the ids and totals are ours, the prices and the student came from
   * the parallel pre-read, and only the order number and createdAt had to be
   * told to us — which the INSERT's RETURNING already did.
   */
  const shape = (draft: OrderDraft, row: { orderNumber: number; createdAt: Date }) => ({
    id: draft.id,
    studentId: ownerData.studentId,
    guestSessionId: ownerData.guestSessionId,
    guestName: ownerData.guestName,
    guestPhone: ownerData.guestPhone,
    status: "PENDING" as const,
    kitchen: draft.kitchen,
    token: draft.token,
    orderNumber: row.orderNumber,
    totalAmount: draft.totalAmount,
    createdAt: row.createdAt,
    collectionAt: slot,
    deliveredAt: null,
    reservedAt,
    reservationExpiresAt: expiresAt,
    stockSettledAt: null,
    seenByAdmin: false,
    seenAt: null,
    lockedByAdminId: null,
    lockedAt: null,
    student,
    items: draft.lines.map((line) => {
      // `category` was joined only to route the line to a kitchen; the order
      // shape callers have always seen carries the menu item without it.
      const { category, ...menuItem } = line.menuItem;
      return {
        id: line.id,
        orderId: draft.id,
        menuItemId: line.menuItem.id,
        quantity: line.qty,
        priceAtOrder: line.menuItem.price,
        menuItem,
      };
    }),
  });

  let orders: ReturnType<typeof shape>[] = [];
  let seatedKitchens: string[] = [];
  // Flips the moment the orders are on disk. After that point the claim is
  // owned by real rows and compensation would be the bug, not the fix.
  let wrote = false;
  try {
    // ---- statement 1b: claim window seats (pre-booked carts only) ---------
    if (slot) {
      const seats = await claimWindowSeats(prisma, slot, kitchens);
      seatedKitchens = [...seats];
      if (seats.size !== kitchens.length) {
        const full = kitchens.filter((k) => !seats.has(k));
        throw new ApiError(
          409,
          "COLLECTION_WINDOW_FULL",
          `The ${slot.toISOString()} collection window is fully booked for the ${full.join(", ")} kitchen. Please pick another time.`,
        );
      }
    }

    // ---- statement 2: write the orders and their items -------------------
    const written = await insertOrders(prisma, drafts, ownerData, slot, reservedAt, expiresAt);
    wrote = true;

    orders = drafts.map((draft) => {
      const row = written.get(draft.id);
      if (!row) throw new ApiError(500, "ORDER_NOT_WRITTEN", "Order could not be created");
      return shape(draft, row);
    });
  } catch (err) {
    // Nothing was written, so nothing may stay claimed. Both give-backs are
    // floored at zero and safe to run against a claim that never landed.
    if (!wrote) {
      await releaseStock(prisma, claims).catch((releaseErr) =>
        console.error("[orders] failed to release stock after a failed order", releaseErr),
      );
      if (slot && seatedKitchens.length > 0) {
        await releaseWindowSeats(prisma, slot, seatedKitchens).catch((releaseErr) =>
          console.error("[orders] failed to release window seats after a failed order", releaseErr),
        );
      }
    }
    throw err;
  }

  // QR rendering is pure CPU and needs nothing but the token, so it happens
  // outside the guarded section, once nothing is being held on anybody else's
  // behalf — and a failure here can no longer look like a failed order and
  // hand back stock that real rows now own.
  return Promise.all(orders.map(async (order) => ({ ...order, qrDataUrl: await qrDataUrl(order.token) })));
}

// ---------------------------------------------------------------------------
// Owner-scoped reads
// ---------------------------------------------------------------------------

export async function getStudentOrders(prisma: PrismaClient, studentId: string) {
  // Self-throttled housekeeping, hung off a read rather than the write path.
  await sweepReservations(prisma);
  const orders = await prisma.order.findMany({
    where: { studentId },
    orderBy: { createdAt: "desc" },
    include: { items: { include: { menuItem: true } } },
  });

  // Attach qrDataUrl to each order so the history can display it if needed
  return Promise.all(
    orders.map(async (order) => {
      return { ...order, qrDataUrl: await qrDataUrl(order.token) };
    })
  );
}

export async function getOrderForStudent(prisma: PrismaClient, orderId: string, studentId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, studentId },
    include: { items: { include: { menuItem: true } } },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");

  return { ...order, qrDataUrl: await qrDataUrl(order.token) };
}

/**
 * A guest's own orders.
 *
 * `guestSessionId` is in the WHERE clause, exactly as `studentId` is for
 * getStudentOrders — it is a scoping predicate, never a post-filter. There is
 * deliberately no "list everything" path a guest can reach.
 */
export async function getGuestOrders(prisma: PrismaClient, guestSessionId: string) {
  const orders = await prisma.order.findMany({
    where: { guestSessionId },
    orderBy: { createdAt: "desc" },
    include: { items: { include: { menuItem: true } } },
  });

  return Promise.all(
    orders.map(async (order) => ({ ...order, qrDataUrl: await qrDataUrl(order.token) })),
  );
}

/**
 * One order, but only if this guest session placed it.
 *
 * Mirrors getOrderForStudent: the ownership check is part of the query, so a
 * guest guessing another order's id gets the same 404 as a guest naming an id
 * that does not exist. Nothing distinguishes "not yours" from "not there".
 */
export async function getOrderForGuest(prisma: PrismaClient, orderId: string, guestSessionId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, guestSessionId },
    include: { items: { include: { menuItem: true } } },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");

  return { ...order, qrDataUrl: await qrDataUrl(order.token) };
}

// ---------------------------------------------------------------------------
// Admin board: cursor-paginated listing
// ---------------------------------------------------------------------------

export const ACTIVE_ORDER_STATUSES = ["PENDING", "PREPARING", "COOKED"] as const;

/** Page size when the caller does not ask for one. */
export const DEFAULT_ORDER_PAGE_SIZE = 50;
/** Hard ceiling — `?limit=100000` must not reintroduce the unbounded scan. */
export const MAX_ORDER_PAGE_SIZE = 200;
/** Widest `from`..`to` span a single query may cover. */
export const MAX_DATE_WINDOW_DAYS = 31;
/**
 * Applied only when DELIVERED orders are included. Active orders are
 * inherently recent and self-limiting, so the board keeps seeing a stale
 * PENDING order from three weeks ago; history, which grows without bound,
 * does not get to be queried from the beginning of time by default.
 */
export const DEFAULT_HISTORY_LOOKBACK_DAYS = 7;

export interface OrderPageOptions {
  kitchen?: string;
  /** Explicit status filter. Wins over `includeDelivered`. */
  statuses?: string[];
  /** Include DELIVERED orders. Default false — the board wants live work. */
  includeDelivered?: boolean;
  cursor?: string;
  limit?: number;
  from?: Date;
  to?: Date;
}

export interface OrderPage<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Keyset cursor over the board's sort key, (createdAt DESC, id DESC).
 *
 * Keyset rather than OFFSET because the board is a live feed: with OFFSET,
 * an order placed mid-scroll shifts every later page by one and the admin
 * silently never sees a row. `id` is the tiebreaker — createdAt alone is not
 * unique, and a duplicate boundary timestamp would drop or repeat rows.
 */
export function encodeOrderCursor(order: { createdAt: Date; id: string }): string {
  return Buffer.from(`${order.createdAt.toISOString()}|${order.id}`).toString("base64url");
}

export function decodeOrderCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = raw.indexOf("|");
  if (sep === -1) throw new ApiError(400, "INVALID_CURSOR", "Malformed pagination cursor");

  const createdAt = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) {
    throw new ApiError(400, "INVALID_CURSOR", "Malformed pagination cursor");
  }
  return { createdAt, id };
}

function resolveDateWindow(options: OrderPageOptions, includesDelivered: boolean) {
  const { from, to } = options;
  if (from && Number.isNaN(from.getTime())) throw new ApiError(400, "INVALID_DATE_RANGE", "`from` is not a valid date");
  if (to && Number.isNaN(to.getTime())) throw new ApiError(400, "INVALID_DATE_RANGE", "`to` is not a valid date");
  if (from && to && from.getTime() > to.getTime()) {
    throw new ApiError(400, "INVALID_DATE_RANGE", "`from` must not be after `to`");
  }

  const maxSpanMs = MAX_DATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (from && to && to.getTime() - from.getTime() > maxSpanMs) {
    throw new ApiError(
      400,
      "DATE_RANGE_TOO_WIDE",
      `Date window may not exceed ${MAX_DATE_WINDOW_DAYS} days`,
    );
  }

  const effectiveFrom =
    from ??
    (includesDelivered
      ? new Date(Date.now() - DEFAULT_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      : undefined);

  if (!effectiveFrom && !to) return undefined;
  return {
    ...(effectiveFrom ? { gte: effectiveFrom } : {}),
    ...(to ? { lte: to } : {}),
  };
}

/**
 * The kitchen board's order feed.
 *
 * Previously returned every order ever placed, each with its items and their
 * menu items joined — and the board refetches on every realtime event. This
 * is now bounded three ways: active statuses only by default, a cursor page
 * of at most MAX_ORDER_PAGE_SIZE, and a date window on history. The
 * (kitchen, status, createdAt) index added alongside serves the default
 * filter+sort directly.
 */
export async function getAllOrders(prisma: PrismaClient, options: OrderPageOptions = {}) {
  // The board polls constantly, which makes it the cheapest place to keep
  // expired reservations from accumulating. Throttled to once a minute.
  await sweepReservations(prisma);
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_ORDER_PAGE_SIZE)),
    MAX_ORDER_PAGE_SIZE,
  );

  const statuses = options.statuses?.length
    ? options.statuses
    : options.includeDelivered
      ? undefined
      : [...ACTIVE_ORDER_STATUSES];

  const includesDelivered = statuses ? statuses.includes("DELIVERED") : true;

  const and: any[] = [];
  if (options.kitchen) and.push({ kitchen: options.kitchen });
  if (statuses) and.push({ status: { in: statuses } });

  const createdAtWindow = resolveDateWindow(options, includesDelivered);
  if (createdAtWindow) and.push({ createdAt: createdAtWindow });

  if (options.cursor) {
    const { createdAt, id } = decodeOrderCursor(options.cursor);
    // Strictly "after" the cursor row in (createdAt DESC, id DESC) order.
    and.push({
      OR: [{ createdAt: { lt: createdAt } }, { AND: [{ createdAt }, { id: { lt: id } }] }],
    });
  }

  // One extra row is fetched purely to answer "is there another page?"
  // without a second COUNT query over the same predicate.
  const rows = await prisma.order.findMany({
    where: and.length ? { AND: and } : {},
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: ADMIN_ORDER_INCLUDE,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    data: page.map(withCustomer),
    nextCursor: hasMore && last ? encodeOrderCursor(last) : null,
    hasMore,
  };
}

export async function getAdminStats(prisma: PrismaClient, kitchen?: string) {
  // Using local timezone roughly by taking midnight of current UTC day
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(startOfDay);
  endOfDay.setHours(23, 59, 59, 999);

  const todaysOrders = await prisma.order.findMany({
    where: {
      ...(kitchen ? { kitchen: kitchen as any } : {}),
      createdAt: {
        gte: startOfDay,
        lte: endOfDay,
      }
    },
    // Only the money column is needed — the previous full-row fetch dragged
    // every column of every order back for a sum.
    select: { totalAmount: true },
  });

  const totalOrdersToday = todaysOrders.length;
  const totalRevenueToday = todaysOrders.reduce((sum, order) => sum + Number(order.totalAmount), 0);

  return {
    totalOrdersToday,
    totalRevenueToday: totalRevenueToday.toFixed(2),
  };
}

const NEXT_STATUS: Record<string, string> = {
  PENDING: "PREPARING",
  PREPARING: "COOKED",
  COOKED: "DELIVERED",
};

export async function openOrderForAdmin(prisma: PrismaClient, orderId: string, adminId: string, adminKitchen?: string | null) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: ADMIN_ORDER_INCLUDE,
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  if (adminKitchen && order.kitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", `This order belongs to the ${order.kitchen} kitchen.`);
  }

  let isLockedByOther = false;
  const now = new Date();
  if (order.status !== "DELIVERED" && order.lockedByAdminId && order.lockedByAdminId !== adminId && order.lockedAt) {
    const lockTimeout = 5 * 60 * 1000;
    if (now.getTime() - order.lockedAt.getTime() < lockTimeout) {
      isLockedByOther = true;
    }
  }

  const data: Record<string, unknown> = {};
  if (!order.seenByAdmin) {
    data.seenByAdmin = true;
    data.seenAt = now;
  }
  if (!isLockedByOther && order.status !== "DELIVERED") {
    data.lockedByAdminId = adminId;
    data.lockedAt = now;
  }

  const updated = Object.keys(data).length > 0
    ? await prisma.order.update({
        where: { id: order.id },
        data,
        include: ADMIN_ORDER_INCLUDE,
      })
    : order;

  return { ...withCustomer(updated), isLockedByOther };
}

export async function updateOrderStatus(prisma: PrismaClient, orderId: string, targetStatus: string, adminKitchen?: string | null) {
  return prisma.$transaction(async (tx) => {
    const orders = await tx.$queryRaw<any[]>`SELECT status, kitchen FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    if (orders.length === 0) throw new ApiError(404, "NOT_FOUND", "Order not found");
    const existing = orders[0];

    if (adminKitchen && existing.kitchen !== adminKitchen) {
      throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to update this kitchen's orders.");
    }
    if (existing.status === "DELIVERED") {
      throw new ApiError(409, "ALREADY_DELIVERED", "Order was already delivered");
    }
    if (NEXT_STATUS[existing.status] !== targetStatus) {
      throw new ApiError(409, "INVALID_TRANSITION", `Cannot move order from ${existing.status} to ${targetStatus}`);
    }

    const data: Record<string, unknown> = { status: targetStatus };

    if (targetStatus === "DELIVERED") {
      // Delivery turns a reservation into a real stock decrement, in one
      // statement instead of the previous fetch + FOR UPDATE + one UPDATE per
      // line item.
      //
      // `settled` is the gate that makes reservedQty move exactly once: only
      // the call that stamps stockSettledAt gives the reservation back, so an
      // order the expiry sweeper already released still hands over the food
      // and still decrements stockQty, without double-crediting the ledger.
      // Orders placed before reservations existed have reservedAt NULL, take
      // the ELSE branch, and behave precisely as they always did.
      //
      // The `stockQty >= qty` guard is what preserves OUT_OF_STOCK at
      // delivery: any line it cannot satisfy comes back named, and because
      // this runs inside the transaction, throwing rolls the partial
      // decrement back rather than leaving half an order delivered.
      const short = await tx.$queryRaw<{ name: string }[]>`
        WITH settled AS (
          UPDATE "Order"
             SET "stockSettledAt" = NOW()
           WHERE "id" = ${orderId}::text
             AND "reservedAt" IS NOT NULL
             AND "stockSettledAt" IS NULL
          RETURNING "id"
        ), need AS (
          SELECT oi."menuItemId" AS mid, SUM(oi."quantity")::int AS qty
            FROM "OrderItem" oi
           WHERE oi."orderId" = ${orderId}::text
           GROUP BY oi."menuItemId"
        ), moved AS (
          UPDATE "MenuItem" m
             SET "stockQty" = m."stockQty" - n.qty,
                 "reservedQty" = CASE WHEN EXISTS (SELECT 1 FROM settled)
                                      THEN GREATEST(0, m."reservedQty" - n.qty)
                                      ELSE m."reservedQty" END
            FROM need n
           WHERE m."id" = n.mid
             AND m."stockQty" >= n.qty
          RETURNING m."id"
        )
        SELECT COALESCE(mi."name", n.mid::text) AS name
          FROM need n
          LEFT JOIN "MenuItem" mi ON mi."id" = n.mid
         WHERE n.mid NOT IN (SELECT "id" FROM moved)
      `;
      if (short.length > 0) {
        throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for ${short.map((r) => r.name).join(", ")}`);
      }
      data.deliveredAt = new Date();
    }

    // Same shape as the admin read paths, `customer` included: the board swaps
    // this payload straight into the order it is displaying, and a response
    // missing `customer` blanks the screen mid-service.
    const updated = await tx.order.update({
      where: { id: orderId },
      data,
      include: ADMIN_ORDER_INCLUDE,
    });
    return withCustomer(updated);
  }, { maxWait: 10_000, timeout: 15_000 });
}


/**
 * Cancels an order and gives its portions back.
 *
 * Scoped by owner when one is supplied, exactly as the read paths are: a
 * student naming somebody else's order id gets the same 404 as a student
 * naming an id that does not exist. Nothing distinguishes "not yours" from
 * "not there".
 *
 * Cancelling is idempotent — an order already CANCELLED returns unchanged and
 * releases nothing a second time, because releaseOrderReservation() only acts
 * on a reservation that is still outstanding.
 */
export async function cancelOrder(
  prisma: PrismaClient,
  orderId: string,
  scope: { studentId?: string; guestSessionId?: string } = {},
) {
  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      ...(scope.studentId ? { studentId: scope.studentId } : {}),
      ...(scope.guestSessionId ? { guestSessionId: scope.guestSessionId } : {}),
    },
    include: { items: { include: { menuItem: true } } },
  });
  if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
  if (order.status === "DELIVERED") {
    throw new ApiError(409, "ALREADY_DELIVERED", "Order was already delivered");
  }
  if (order.status === "CANCELLED") return order;

  await releaseOrderReservation(prisma, orderId);

  return prisma.order.update({
    where: { id: orderId },
    data: { status: "CANCELLED" },
    include: { items: { include: { menuItem: true } } },
  });
}
