import type { Pool, PoolClient } from "@neondatabase/serverless";
import { sql, joinSql, query } from "../db/sql.js";
import type { SqlFragment } from "../db/sql.js";
import { withTransaction } from "../db/tx.js";
import { WhereBuilder } from "../db/where.js";
import type { Order, OrderItem, MenuItem, CollectionWindow, OrderStatus, Kitchen } from "../db/schema.js";
import { ApiError } from "../middleware/errorHandler.js";
import { isUniqueViolationOn } from "../db/errors.js";

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
  /**
   * Holds the order back from the kitchen until a payment settles it.
   *
   * Stock is claimed either way — the reservation is what stops the cart being
   * sold out from under a student during the two-minute payment window — but
   * an order flagged here is invisible to the board and to the admin stats
   * until services/paymentService.ts clears the flag on a confirmed webhook.
   * Defaults to false, so every existing caller keeps today's behaviour.
   */
  awaitingPayment?: boolean;
}

// ---------------------------------------------------------------------------
// Owner invariant
// ---------------------------------------------------------------------------

function isGuestOwner(owner: OrderOwner): owner is GuestOwner {
  return "guestSessionId" in owner;
}

/**
 * An order is student-owned OR guest-owned. Enforced here because Postgres
 * cannot express "exactly one of these two columns is non-null" through a
 * simple CHECK across nullable FKs of different tables, and because every
 * read path downstream — student scoping, guest scoping, the kitchen board's
 * "who is this for" column — assumes it holds. Both-set would make an order
 * readable by two unrelated parties; neither-set would make it readable by
 * no one and unattributable on the board.
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
 * Anything that can run a raw statement — the pool itself or a transaction's
 * checked-out client. The reservation primitives deliberately do not require
 * a transaction: their whole point is that each one is atomic on its own.
 */
type RawRunner = Pick<Pool | PoolClient, "query">;

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
  return joinSql(claims.map((c) => sql`(${c.menuItemId}::text, ${c.qty}::int)`));
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
  const { rows: claimed } = await query<{ id: string }>(
    db,
    sql`
    UPDATE "MenuItem" m
       SET "reservedQty" = m."reservedQty" + r.qty
      FROM (VALUES ${claimValues(claims)}) AS r(id, qty)
     WHERE m.id = r.id
       AND m."isAvailable" = TRUE
       AND m."isArchived" = FALSE
       AND m."stockQty" - m."reservedQty" >= r.qty
    RETURNING m.id
  `,
  );
  return new Set(claimed.map((row) => row.id));
}

/**
 * Hands portions back. GREATEST(0, ...) is a floor, not a guess: reservedQty
 * must never go negative, because a negative reservation would silently
 * inflate what the next basket is allowed to claim.
 */
async function releaseStock(db: RawRunner, claims: StockClaim[]): Promise<void> {
  if (claims.length === 0) return;
  await query(
    db,
    sql`
    UPDATE "MenuItem" m
       SET "reservedQty" = GREATEST(0, m."reservedQty" - r.qty)
      FROM (VALUES ${claimValues(claims)}) AS r(id, qty)
     WHERE m.id = r.id
  `,
  );
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
  const { rows: released } = await query<{ id: string }>(
    db,
    sql`
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
  `,
  );
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
  const { rows } = await query<{ id: string }>(
    db,
    sql`
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
  `,
  );
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
  const { rowCount } = await query(
    db,
    sql`
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
  `,
  );
  return rowCount;
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
  const valueRows = joinSql(kitchens.map((kitchen) => sql`(${crypto.randomUUID()}::text, ${kitchen}::text)`));
  const { rows: claimed } = await query<{ kitchen: string }>(
    db,
    sql`
    INSERT INTO "CollectionWindow" ("id", "startAt", "kitchen", "capacity", "bookedCount", "createdAt")
    SELECT v.id, ${slot.toISOString()}::timestamp, v.kitchen::"Kitchen", ${DEFAULT_WINDOW_CAPACITY}::int, 1, NOW()
      FROM (VALUES ${valueRows}) AS v(id, kitchen)
    ON CONFLICT ("startAt", "kitchen") DO UPDATE
       SET "bookedCount" = "CollectionWindow"."bookedCount" + 1
     WHERE "CollectionWindow"."bookedCount" < "CollectionWindow"."capacity"
    RETURNING "kitchen"::text AS kitchen
  `,
  );
  return new Set(claimed.map((row) => row.kitchen));
}

/** Hands seats back after a claim that could not be completed. */
async function releaseWindowSeats(db: RawRunner, slot: Date, kitchens: string[]): Promise<void> {
  if (kitchens.length === 0) return;
  await query(
    db,
    sql`
    UPDATE "CollectionWindow"
       SET "bookedCount" = GREATEST(0, "bookedCount" - 1)
     WHERE "startAt" = ${slot.toISOString()}::timestamp
       AND "kitchen"::text = ANY(${kitchens}::text[])
  `,
  );
}

/**
 * Remaining capacity per slot for a kitchen, so a client can grey out full
 * windows instead of discovering them at checkout. Slots with no ledger row
 * yet are simply absent — they are empty by definition.
 */
export async function getCollectionWindows(pool: Pool, kitchen: string, from: Date, to: Date) {
  // Bounds are passed as explicit ISO-UTC strings cast to `::timestamp`,
  // matching the rest of this file's own convention (see insertOrders,
  // claimWindowSeats) — a raw JS Date object handed to the driver as a
  // parameter for a `timestamp without time zone` column is serialized using
  // the *local* wall-clock time of the process, not UTC, which silently
  // shifts this WHERE clause by the host's UTC offset. Casting an ISO string
  // sidesteps that: Postgres reads the string's own digits directly.
  const { rows } = await query<CollectionWindow>(
    pool,
    sql`
    SELECT * FROM "CollectionWindow"
     WHERE "kitchen" = ${kitchen}::"Kitchen"
       AND "startAt" >= ${from.toISOString()}::timestamp
       AND "startAt" <= ${to.toISOString()}::timestamp
     ORDER BY "startAt" ASC
  `,
  );
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
// Relational read hydration
// ---------------------------------------------------------------------------

/** Minimal student identity an admin view needs — never the whole User row. */
interface StudentSummary {
  id: string;
  name: string;
  rollNumber: string | null;
  email: string;
}

interface OrderItemJoinRow {
  id: string;
  orderId: string;
  menuItemId: string;
  quantity: number;
  priceAtOrder: string;
  mi_id: string;
  mi_name: string;
  mi_imageUrl: string | null;
  mi_imageHash: string | null;
  mi_price: string;
  mi_stockQty: number;
  mi_reservedQty: number;
  mi_isAvailable: boolean;
  mi_isArchived: boolean;
  mi_categoryId: string;
  mi_sortOrder: number;
  mi_servingInfo: string | null;
  mi_servingInfoVisible: boolean;
}

/**
 * One shared hydration path for every order read, replacing Prisma's
 * `ADMIN_ORDER_INCLUDE` (`items: { include: { menuItem: true } }`,
 * `student: STUDENT_SUMMARY`). Two queries total, regardless of how many
 * orders are being hydrated — items+menuItem joined once for every order id,
 * and students joined once for every distinct studentId among them — then
 * assembled in memory. Callers fetch the base `Order` rows themselves (each
 * read path has its own WHERE/ORDER BY/LIMIT), then hand them here.
 */
async function hydrateOrders<T extends { id: string; studentId: string | null }>(
  runner: RawRunner,
  orders: T[],
  opts: { maskHiddenServingInfo?: boolean } = {},
): Promise<(T & { items: (OrderItem & { menuItem: MenuItem })[]; student: StudentSummary | null })[]> {
  if (orders.length === 0) return [];
  const orderIds = orders.map((o) => o.id);
  const studentIds = [...new Set(orders.map((o) => o.studentId).filter((id): id is string => Boolean(id)))];

  const [{ rows: itemRows }, { rows: studentRows }] = await Promise.all([
    query<OrderItemJoinRow>(
      runner,
      sql`
      SELECT oi."id" AS "id", oi."orderId" AS "orderId", oi."menuItemId" AS "menuItemId",
             oi."quantity" AS "quantity", oi."priceAtOrder"::text AS "priceAtOrder",
             mi."id" AS "mi_id", mi."name" AS "mi_name", mi."imageUrl" AS "mi_imageUrl",
             mi."imageHash" AS "mi_imageHash",
             mi."price"::text AS "mi_price", mi."stockQty" AS "mi_stockQty",
             mi."reservedQty" AS "mi_reservedQty", mi."isAvailable" AS "mi_isAvailable",
             mi."isArchived" AS "mi_isArchived", mi."categoryId" AS "mi_categoryId",
             mi."sortOrder" AS "mi_sortOrder", mi."servingInfo" AS "mi_servingInfo",
             mi."servingInfoVisible" AS "mi_servingInfoVisible"
        FROM "OrderItem" oi
        JOIN "MenuItem" mi ON mi."id" = oi."menuItemId"
       WHERE oi."orderId" = ANY(${orderIds}::text[])
    `,
    ),
    studentIds.length > 0
      ? query<StudentSummary>(
          runner,
          sql`SELECT "id", "name", "rollNumber", "email" FROM "User" WHERE "id" = ANY(${studentIds}::text[])`,
        )
      : Promise.resolve({ rows: [] as StudentSummary[], rowCount: 0 }),
  ]);

  const itemsByOrder = new Map<string, (OrderItem & { menuItem: MenuItem })[]>();
  for (const row of itemRows) {
    const bucket = itemsByOrder.get(row.orderId) ?? [];
    bucket.push({
      id: row.id,
      orderId: row.orderId,
      menuItemId: row.menuItemId,
      quantity: row.quantity,
      priceAtOrder: row.priceAtOrder,
      menuItem: {
        id: row.mi_id,
        name: row.mi_name,
        imageUrl: row.mi_imageUrl,
        imageHash: row.mi_imageHash,
        price: row.mi_price,
        stockQty: row.mi_stockQty,
        reservedQty: row.mi_reservedQty,
        isAvailable: row.mi_isAvailable,
        isArchived: row.mi_isArchived,
        categoryId: row.mi_categoryId,
        sortOrder: row.mi_sortOrder,
        // Same rule as the live menu (getCategorizedMenu): hidden text stays
        // hidden in a student's/guest's own order history too, not just the menu.
        servingInfo: opts.maskHiddenServingInfo && !row.mi_servingInfoVisible ? null : row.mi_servingInfo,
        servingInfoVisible: row.mi_servingInfoVisible,
      },
    });
    itemsByOrder.set(row.orderId, bucket);
  }

  const studentById = new Map(studentRows.map((s) => [s.id, s]));

  return orders.map((order) => ({
    ...order,
    items: itemsByOrder.get(order.id) ?? [],
    student: order.studentId ? (studentById.get(order.studentId) ?? null) : null,
  }));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * A random 4-digit token, shoutable at the counter. Uniqueness among a
 * kitchen's still-open orders is NOT enforced here — that's the partial
 * unique index on Order("kitchen", "orderNumber"); a collision surfaces as
 * 23505 and insertOrders() retries with a fresh number instead of this
 * function coordinating anything.
 */
function randomOrderNumber(): number {
  return 1000 + Math.floor(Math.random() * 9000);
}

/** insertOrders() retries this many times before giving up on a collision. */
const MAX_ORDER_NUMBER_ATTEMPTS = 8;

/** MenuItem plus the kitchen its category routes it to — the join createOrder needs. */
interface MenuItemWithCategory extends MenuItem {
  categoryKitchen: Kitchen;
}

interface OrderDraft {
  id: string;
  kitchen: string;
  token: string;
  totalAmount: string;
  lines: { id: string; menuItem: MenuItemWithCategory; qty: number }[];
}

/**
 * Writes the whole cart — every order and every line item — in ONE statement.
 *
 * Two things were costing round trips to a database on the other side of an
 * ocean, and both are gone:
 *
 *  - The order number. It used to come from an upsert-with-increment against
 *    a single OrderSequence row, so every order on campus queued behind one
 *    row lock held for the rest of the transaction. `nextval()` is
 *    non-transactional and takes no row lock at all, and evaluated inline in
 *    this INSERT it costs no round trip either.
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
  awaitingPayment: boolean,
): Promise<Map<string, { orderNumber: number; createdAt: Date }>> {
  const itemRows = joinSql(
    drafts.flatMap((d) =>
      d.lines.map(
        (line) =>
          sql`(${line.id}::text, ${d.id}::text, ${line.menuItem.id}::text, ${line.qty}::int, ${String(line.menuItem.price)}::text)`,
      ),
    ),
  );

  // A collision (two open orders in the same kitchen drawing the same
  // 4-digit number) is rare but not impossible — the partial unique index on
  // Order("kitchen", "orderNumber") is what actually catches it, named
  // explicitly below so this only retries ON THAT constraint. Order also has
  // a separate UNIQUE index on "token" (a fresh randomUUID() per draft); a
  // 23505 from that — or any future unique constraint on the table — must
  // not be swallowed as "just re-roll the number" and looped on uselessly.
  //
  // At realistic volumes the retry is essentially never needed: with N open
  // orders in a kitchen sharing the 9000-number space, a fresh draw collides
  // with probability N/9000, so even N=300 open orders (already high for a
  // canteen — PENDING/PREPARING/COOKED only, expiring within hours) fails
  // all 8 attempts with probability ~0.033^8, effectively zero.
  const ORDER_NUMBER_CONSTRAINT = "Order_kitchen_orderNumber_open_key";
  for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt++) {
    const orderRows = joinSql(
      drafts.map(
        (d) =>
          sql`(${d.id}::text, ${d.kitchen}::text, ${d.token}::text, ${randomOrderNumber()}::int, ${d.totalAmount}::text)`,
      ),
    );

    try {
      const { rows: inserted } = await query<{ id: string; orderNumber: number; createdAt: Date }>(
        db,
        sql`
        WITH new_orders AS (
          INSERT INTO "Order" (
            "id", "studentId", "guestSessionId", "guestName", "guestPhone",
            "kitchen", "token", "orderNumber", "totalAmount",
            "collectionAt", "reservedAt", "reservationExpiresAt", "awaitingPayment"
          )
          SELECT v.id,
                 ${ownerData.studentId}::text,
                 ${ownerData.guestSessionId}::text,
                 ${ownerData.guestName}::text,
                 ${ownerData.guestPhone}::text,
                 v.kitchen::"Kitchen",
                 v.token,
                 v.num,
                 v.total::numeric(10, 2),
                 ${slot ? slot.toISOString() : null}::timestamp,
                 ${reservedAt.toISOString()}::timestamp,
                 ${expiresAt.toISOString()}::timestamp,
                 ${awaitingPayment}::boolean
            FROM (VALUES ${orderRows}) AS v(id, kitchen, token, num, total)
          RETURNING "id", "orderNumber", "createdAt"
        ), new_items AS (
          INSERT INTO "OrderItem" ("id", "orderId", "menuItemId", "quantity", "priceAtOrder")
          SELECT w.id, w."orderId", w."menuItemId", w.qty, w.price::numeric(10, 2)
            FROM (VALUES ${itemRows}) AS w(id, "orderId", "menuItemId", qty, price)
          RETURNING "id"
        )
        SELECT "id", "orderNumber", "createdAt" FROM new_orders
      `,
      );

      return new Map(inserted.map((row) => [row.id, { orderNumber: row.orderNumber, createdAt: row.createdAt }]));
    } catch (err) {
      if (!isUniqueViolationOn(err, ORDER_NUMBER_CONSTRAINT) || attempt === MAX_ORDER_NUMBER_ATTEMPTS) throw err;
    }
  }

  // Unreachable — the loop above always returns or throws.
  throw new ApiError(500, "ORDER_NUMBER_EXHAUSTED", "Could not assign an order number");
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
 * one round trip).
 *
 * THIS FUNCTION MUST NOT BE WRAPPED IN A TRANSACTION — see above.
 */
export async function createOrder(
  pool: Pool,
  { owner, items, collectionAt, awaitingPayment = false }: CreateOrderInput,
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
  const [{ rows: menuItems }, { rows: studentRows }] = await Promise.all([
    query<MenuItemWithCategory>(
      pool,
      sql`
      SELECT mi.*, c."kitchen" AS "categoryKitchen"
        FROM "MenuItem" mi
        JOIN "Category" c ON c."id" = mi."categoryId"
       WHERE mi."id" = ANY(${menuItemIds}::text[]) AND mi."isArchived" = FALSE
    `,
    ),
    ownerData.studentId
      ? query<StudentSummary>(
          pool,
          sql`SELECT "id", "name", "rollNumber", "email" FROM "User" WHERE "id" = ${ownerData.studentId}::text LIMIT 1`,
        )
      : Promise.resolve({ rows: [] as StudentSummary[], rowCount: 0 }),
  ]);
  const student = studentRows[0] ?? null;

  const menuItemById = new Map(menuItems.map((item) => [item.id, item]));
  const missing = menuItemIds.filter((id) => !menuItemById.has(id));
  if (missing.length > 0) {
    throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for ${missing.join(", ")}`);
  }

  const claims: StockClaim[] = menuItemIds.map((id) => ({ menuItemId: id, qty: wanted.get(id)! }));

  // ---- statement 1: claim stock -------------------------------------------
  const claimed = await claimStock(pool, claims);
  if (claimed.size !== claims.length) {
    const short = claims.filter((c) => !claimed.has(c.menuItemId));
    await releaseStock(pool, claims.filter((c) => claimed.has(c.menuItemId)));
    const names = short.map((c) => menuItemById.get(c.menuItemId)?.name ?? c.menuItemId);
    throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for ${names.join(", ")}`);
  }

  // A cart spanning both kitchens becomes two orders, and each kitchen cooks
  // its own half, so each is numbered and seated on its own.
  const byKitchen = new Map<string, { menuItem: MenuItemWithCategory; qty: number }[]>();
  for (const id of menuItemIds) {
    const menuItem = menuItemById.get(id)!;
    const kitchen = menuItem.categoryKitchen || "SNACKS";
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
      // Opaque unique row key, nothing more: the UNIQUE constraint on
      // Order.token is what it exists for. Collection is by order number.
      token: crypto.randomUUID(),
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
    awaitingPayment,
    student,
    items: draft.lines.map((line) => {
      // `categoryKitchen` was joined only to route the line to a kitchen; the
      // order shape callers have always seen carries the menu item without it.
      const { categoryKitchen, ...menuItem } = line.menuItem;
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
      const seats = await claimWindowSeats(pool, slot, kitchens);
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
    const written = await insertOrders(pool, drafts, ownerData, slot, reservedAt, expiresAt, awaitingPayment);
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
      await releaseStock(pool, claims).catch((releaseErr) =>
        console.error("[orders] failed to release stock after a failed order", releaseErr),
      );
      if (slot && seatedKitchens.length > 0) {
        await releaseWindowSeats(pool, slot, seatedKitchens).catch((releaseErr) =>
          console.error("[orders] failed to release window seats after a failed order", releaseErr),
        );
      }
    }
    throw err;
  }

  return orders;
}

// ---------------------------------------------------------------------------
// Owner-scoped reads
// ---------------------------------------------------------------------------

export async function getStudentOrders(pool: Pool, studentId: string) {
  // Self-throttled housekeeping, hung off a read rather than the write path.
  await sweepReservations(pool);
  const { rows } = await query<Order>(
    pool,
    sql`SELECT * FROM "Order" WHERE "studentId" = ${studentId}::text ORDER BY "createdAt" DESC`,
  );
  return hydrateOrders(pool, rows, { maskHiddenServingInfo: true });
}

export async function getOrderForStudent(pool: Pool, orderId: string, studentId: string) {
  const { rows } = await query<Order>(
    pool,
    sql`SELECT * FROM "Order" WHERE "id" = ${orderId}::text AND "studentId" = ${studentId}::text LIMIT 1`,
  );
  if (rows.length === 0) throw new ApiError(404, "NOT_FOUND", "Order not found");

  const [order] = await hydrateOrders(pool, rows, { maskHiddenServingInfo: true });
  return order;
}

/**
 * A guest's own orders.
 *
 * `guestSessionId` is in the WHERE clause, exactly as `studentId` is for
 * getStudentOrders — it is a scoping predicate, never a post-filter. There is
 * deliberately no "list everything" path a guest can reach.
 */
export async function getGuestOrders(pool: Pool, guestSessionId: string) {
  const { rows } = await query<Order>(
    pool,
    sql`SELECT * FROM "Order" WHERE "guestSessionId" = ${guestSessionId}::text ORDER BY "createdAt" DESC`,
  );
  return hydrateOrders(pool, rows, { maskHiddenServingInfo: true });
}

/**
 * One order, but only if this guest session placed it.
 *
 * Mirrors getOrderForStudent: the ownership check is part of the query, so a
 * guest guessing another order's id gets the same 404 as a guest naming an id
 * that does not exist. Nothing distinguishes "not yours" from "not there".
 */
export async function getOrderForGuest(pool: Pool, orderId: string, guestSessionId: string) {
  const { rows } = await query<Order>(
    pool,
    sql`SELECT * FROM "Order" WHERE "id" = ${orderId}::text AND "guestSessionId" = ${guestSessionId}::text LIMIT 1`,
  );
  if (rows.length === 0) throw new ApiError(404, "NOT_FOUND", "Order not found");

  const [order] = await hydrateOrders(pool, rows, { maskHiddenServingInfo: true });
  return order;
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
export async function getAllOrders(pool: Pool, options: OrderPageOptions = {}) {
  // The board polls constantly, which makes it the cheapest place to keep
  // expired reservations from accumulating. Throttled to once a minute.
  await sweepReservations(pool);
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

  const where = new WhereBuilder();
  // An order whose payment has not settled does not exist as far as the
  // kitchen is concerned. It holds its stock, so nobody else can buy the food
  // out from under it, but it is not cooked and not counted until the webhook
  // confirms — and if the payment window lapses instead, it is cancelled and
  // the portions go back. Orders placed while payments are switched off carry
  // FALSE here and are unaffected.
  where.and(`"awaitingPayment" = FALSE`);
  if (options.kitchen) where.and(`"kitchen" = $1::"Kitchen"`, options.kitchen);
  if (statuses) where.and(`"status"::text = ANY($1::text[])`, statuses);

  // Date bounds are passed as ISO-UTC strings cast to `::timestamp` rather
  // than raw JS Date objects — see the comment on getCollectionWindows for
  // why a bare Date parameter against a `timestamp without time zone` column
  // is silently shifted by the process's local UTC offset.
  const createdAtWindow = resolveDateWindow(options, includesDelivered);
  if (createdAtWindow?.gte) where.and(`"createdAt" >= $1::timestamp`, createdAtWindow.gte.toISOString());
  if (createdAtWindow?.lte) where.and(`"createdAt" <= $1::timestamp`, createdAtWindow.lte.toISOString());

  if (options.cursor) {
    const { createdAt, id } = decodeOrderCursor(options.cursor);
    // Strictly "after" the cursor row in (createdAt DESC, id DESC) order.
    where.and(
      `("createdAt" < $1::timestamp OR ("createdAt" = $1::timestamp AND "id" < $2))`,
      createdAt.toISOString(),
      id,
    );
  }

  // One extra row is fetched purely to answer "is there another page?"
  // without a second COUNT query over the same predicate.
  const { rows } = await query<Order>(
    pool,
    sql`
    SELECT * FROM "Order"
     WHERE ${where.build()}
     ORDER BY "createdAt" DESC, "id" DESC
     LIMIT ${limit + 1}
  `,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const hydrated = await hydrateOrders(pool, page);
  const last = hydrated[hydrated.length - 1];

  return {
    data: hydrated.map(withCustomer),
    nextCursor: hasMore && last ? encodeOrderCursor(last) : null,
    hasMore,
  };
}

export async function getAdminStats(pool: Pool, kitchen?: string) {
  // Using local timezone roughly by taking midnight of current UTC day
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(startOfDay);
  endOfDay.setHours(23, 59, 59, 999);

  const where = new WhereBuilder();
  // ISO-UTC strings cast to `::timestamp`, not raw Date params — see the
  // comment on getCollectionWindows.
  where.and(`"createdAt" >= $1::timestamp AND "createdAt" <= $2::timestamp`, startOfDay.toISOString(), endOfDay.toISOString());
  // Money that has not arrived is not revenue. An unsettled order is excluded
  // from both the count and the total until its payment confirms.
  where.and(`"awaitingPayment" = FALSE`);
  if (kitchen) where.and(`"kitchen" = $1::"Kitchen"`, kitchen);

  // Only the money column is needed — the previous full-row fetch dragged
  // every column of every order back for a sum.
  const { rows: todaysOrders } = await query<{ totalAmount: string }>(
    pool,
    sql`SELECT "totalAmount" FROM "Order" WHERE ${where.build()}`,
  );

  const totalOrdersToday = todaysOrders.length;
  const totalRevenueToday = todaysOrders.reduce((sum, order) => sum + Number(order.totalAmount), 0);

  return {
    totalOrdersToday,
    totalRevenueToday: totalRevenueToday.toFixed(2),
  };
}

/**
 * The board is a two-step flow: PENDING -> COOKED ("Order Prepared") ->
 * DELIVERED ("Collected"). PREPARING is retired — nothing transitions *into*
 * it any more — but rows already sitting in it from before this change must
 * still be movable, so the PREPARING -> COOKED edge stays.
 */
const NEXT_STATUS: Record<string, string> = {
  PENDING: "COOKED",
  PREPARING: "COOKED",
  COOKED: "DELIVERED",
};

export async function openOrderForAdmin(pool: Pool, orderId: string, adminId: string, adminKitchen?: string | null) {
  // Read-then-write collapsed into one round trip: every CASE branch that
  // depends on the row's *current* state (kitchen match, already-seen,
  // someone else's lock) reads the pre-update column directly, so an
  // unauthorized or already-current request is a harmless no-op write
  // instead of skipping the statement — the extra WAL entry is far cheaper
  // than the round trip a separate SELECT used to cost on every open.
  //
  // ISO-UTC string cast to `::timestamp`, not a raw Date param — see the
  // comment on getCollectionWindows.
  const nowIso = new Date().toISOString();
  const authorized = adminKitchen ? sql`"kitchen" = ${adminKitchen}::"Kitchen"` : sql`TRUE`;
  const lockedByOtherStillValid = sql`
    "status" <> 'DELIVERED'
    AND "lockedByAdminId" IS NOT NULL
    AND "lockedByAdminId" <> ${adminId}::text
    AND "lockedAt" IS NOT NULL
    AND ${nowIso}::timestamp - "lockedAt" < interval '5 minutes'
  `;

  const { rows } = await query<Order>(
    pool,
    sql`
      UPDATE "Order" SET
        "seenByAdmin" = CASE WHEN (${authorized}) THEN TRUE ELSE "seenByAdmin" END,
        "seenAt" = CASE
          WHEN (${authorized}) AND NOT "seenByAdmin" THEN ${nowIso}::timestamp
          ELSE "seenAt"
        END,
        "lockedByAdminId" = CASE
          WHEN NOT (${authorized}) OR "status" = 'DELIVERED' OR (${lockedByOtherStillValid}) THEN "lockedByAdminId"
          ELSE ${adminId}::text
        END,
        "lockedAt" = CASE
          WHEN NOT (${authorized}) OR "status" = 'DELIVERED' OR (${lockedByOtherStillValid}) THEN "lockedAt"
          ELSE ${nowIso}::timestamp
        END
      WHERE "id" = ${orderId}::text
      RETURNING *
    `,
  );
  if (rows.length === 0) throw new ApiError(404, "NOT_FOUND", "Order not found");
  const order = rows[0];
  if (adminKitchen && order.kitchen !== adminKitchen) {
    throw new ApiError(403, "INVALID_KITCHEN", `This order belongs to the ${order.kitchen} kitchen.`);
  }

  // Mirrors lockedByOtherStillValid against the POST-update row: when it was
  // true, our own UPDATE left lockedByAdminId/lockedAt untouched (still the
  // other admin's), so re-evaluating in JS against the returned row gives
  // the same answer the old pre-update check gave.
  const isLockedByOther =
    order.status !== "DELIVERED" &&
    order.lockedByAdminId != null &&
    order.lockedByAdminId !== adminId &&
    order.lockedAt != null &&
    new Date(nowIso).getTime() - order.lockedAt.getTime() < 5 * 60 * 1000;

  const [hydrated] = await hydrateOrders(pool, [order]);
  return { ...withCustomer(hydrated), isLockedByOther };
}

export async function updateOrderStatus(pool: Pool, orderId: string, targetStatus: string, adminKitchen?: string | null) {
  return withTransaction(pool, async (client) => {
    const { rows: existingRows } = await query<{ status: OrderStatus; kitchen: Kitchen; awaitingPayment: boolean }>(
      client,
      sql`SELECT "status", "kitchen", "awaitingPayment" FROM "Order" WHERE "id" = ${orderId}::text FOR UPDATE`,
    );
    if (existingRows.length === 0) throw new ApiError(404, "NOT_FOUND", "Order not found");
    const existing = existingRows[0];

    if (adminKitchen && existing.kitchen !== adminKitchen) {
      throw new ApiError(403, "INVALID_KITCHEN", "You do not have permission to update this kitchen's orders.");
    }
    // Belt and braces: getAllOrders already hides unsettled orders, so an
    // admin has no way to see this one. Refused here as well because the cost
    // of the check is nothing and the cost of being wrong is food handed over
    // for money that never arrived.
    if (existing.awaitingPayment) {
      throw new ApiError(409, "AWAITING_PAYMENT", "This order has not been paid for yet.");
    }
    if (existing.status === "DELIVERED") {
      throw new ApiError(409, "ALREADY_DELIVERED", "Order was already delivered");
    }
    if (NEXT_STATUS[existing.status] !== targetStatus) {
      throw new ApiError(409, "INVALID_TRANSITION", `Cannot move order from ${existing.status} to ${targetStatus}`);
    }

    const sets: SqlFragment[] = [sql`"status" = ${targetStatus}::"OrderStatus"`];

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
      const { rows: short } = await query<{ name: string }>(
        client,
        sql`
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
      `,
      );
      if (short.length > 0) {
        throw new ApiError(409, "OUT_OF_STOCK", `Insufficient stock for ${short.map((r) => r.name).join(", ")}`);
      }
      // ISO-UTC string cast to `::timestamp`, not a raw Date param — see the
      // comment on getCollectionWindows.
      sets.push(sql`"deliveredAt" = ${new Date().toISOString()}::timestamp`);
    }

    // Same shape as the admin read paths, `customer` included: the board swaps
    // this payload straight into the order it is displaying, and a response
    // missing `customer` blanks the screen mid-service.
    const { rows: updatedRows } = await query<Order>(
      client,
      sql`UPDATE "Order" SET ${joinSql(sets)} WHERE "id" = ${orderId}::text RETURNING *`,
    );
    const [hydrated] = await hydrateOrders(client, updatedRows);
    return withCustomer(hydrated);
  });
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
  pool: Pool,
  orderId: string,
  scope: { studentId?: string; guestSessionId?: string } = {},
) {
  const where = new WhereBuilder();
  where.and(`"id" = $1::text`, orderId);
  if (scope.studentId) where.and(`"studentId" = $1::text`, scope.studentId);
  if (scope.guestSessionId) where.and(`"guestSessionId" = $1::text`, scope.guestSessionId);

  const { rows } = await query<Order>(pool, sql`SELECT * FROM "Order" WHERE ${where.build()} LIMIT 1`);
  if (rows.length === 0) throw new ApiError(404, "NOT_FOUND", "Order not found");
  const order = rows[0];
  if (order.status === "DELIVERED") {
    throw new ApiError(409, "ALREADY_DELIVERED", "Order was already delivered");
  }
  if (order.status === "CANCELLED") {
    const [hydrated] = await hydrateOrders(pool, [order], { maskHiddenServingInfo: true });
    return hydrated;
  }

  await releaseOrderReservation(pool, orderId);

  const { rows: updatedRows } = await query<Order>(
    pool,
    sql`UPDATE "Order" SET "status" = 'CANCELLED'::"OrderStatus" WHERE "id" = ${orderId}::text RETURNING *`,
  );
  const [hydrated] = await hydrateOrders(pool, updatedRows, { maskHiddenServingInfo: true });
  return hydrated;
}
