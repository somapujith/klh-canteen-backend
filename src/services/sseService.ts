/**
 * Worker-side API for the real-time layer.
 *
 * Callers (routes, orderService, menuService) never touch the Durable Object
 * directly — they call the `emit*` functions below, which decide which
 * shard(s) a change belongs on and hand it to the hub. The hub coalesces and
 * fans out; nothing here blocks on delivery.
 *
 * See REALTIME_API.md at the repo root for the call signatures and payload
 * shapes, and src/lib/realtime.ts for the type definitions.
 *
 * BACKWARD COMPATIBILITY
 * The v1 entry points — `sseService.broadcastMenuUpdate(env)`,
 * `.broadcastOrderBoardUpdate(env)`, `.notifyOrderUpdate(env, studentId,
 * orderId, status)` — still exist and still work. They now emit a
 * `FULL_REFRESH` delta, i.e. they mean exactly what they always meant
 * ("something changed, refetch"), so call sites can migrate one at a time.
 */
import {
  EVENT_MENU_UPDATE,
  EVENT_ORDER_BOARD_UPDATE,
  EVENT_ORDER_UPDATE,
  HUB_SHARDS,
  shardForSubject,
  shardsForAudience,
} from "../lib/realtime.js";
import type {
  Audience,
  EmitRequestItem,
  HubShard,
  Kitchen,
  MenuItemSummary,
  OrderSummary,
  StockDelta,
  Subscription,
} from "../lib/realtime.js";
import type { Bindings } from "../types.js";

type HubEnv = Pick<Bindings, "ORDER_EVENTS_HUB">;

/**
 * The hub binding is absent under plain Node (vitest via @hono/node-server),
 * where Durable Objects do not exist. Every emit degrades to a silent no-op
 * there rather than throwing inside a business transaction.
 */
function getShardStub(env: HubEnv, shard: HubShard): DurableObjectStub | null {
  if (!env.ORDER_EVENTS_HUB) return null;
  return env.ORDER_EVENTS_HUB.get(env.ORDER_EVENTS_HUB.idFromName(`hub:${shard}`));
}

/**
 * Route each item to its shard(s) and post one batched request per shard.
 *
 * Sending the whole batch in one request per shard matters: the hub's
 * coalescing window only helps if the Worker is not already making one
 * round-trip per delta.
 */
async function emit(env: HubEnv, items: EmitRequestItem[]): Promise<void> {
  if (!env.ORDER_EVENTS_HUB || items.length === 0) return;

  const byShard = new Map<HubShard, EmitRequestItem[]>();
  for (const item of items) {
    for (const shard of shardsForAudience(item.audience)) {
      const bucket = byShard.get(shard);
      if (bucket) bucket.push(item);
      else byShard.set(shard, [item]);
    }
  }

  await Promise.all(
    [...byShard.entries()].map(async ([shard, shardItems]) => {
      const stub = getShardStub(env, shard);
      if (!stub) return;
      try {
        await stub.fetch(`https://order-events-hub/emit?shard=${shard}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: shardItems }),
        });
      } catch (err) {
        // A hub that is briefly unreachable must never fail the order that
        // triggered the event. Clients recover on their next reconnect via
        // the resume cursor, or via SYNC_REQUIRED.
        console.error(`[sse] emit to shard ${shard} failed`, err);
      }
    }),
  );
}

const ALL: Audience = { scope: "ALL" };
const kitchenAudience = (kitchen: Kitchen): Audience => ({ scope: "KITCHEN", kitchen });
const subjectAudience = (subjectId: string): Audience => ({ scope: "SUBJECT", subjectId });

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export interface ConnectOptions {
  /** Student id, admin id, or guest session id. */
  subjectId: string;
  role: string;
  /**
   * Kitchen board(s) this connection watches. Kitchen admins pass their own
   * kitchen; students pass nothing (they watch the menu, not the board).
   */
  kitchens?: (Kitchen | string | null | undefined)[];
  /** Overrides the shard a connection is pinned to. Admins are pinned to
   *  their kitchen; students are hashed evenly across the shards. */
  shard?: HubShard;
}

function normaliseKitchens(kitchens: ConnectOptions["kitchens"]): Kitchen[] {
  if (!kitchens) return [];
  return kitchens.filter((k): k is Kitchen => k === "SNACKS" || k === "MEALS");
}

/**
 * Which shard holds a given connection. Admins sit on the shard carrying their
 * own kitchen's board so kitchen traffic never crosses shards; everyone else
 * is hashed, which splits the student population evenly.
 */
export function shardForConnection(options: ConnectOptions): HubShard {
  if (options.shard && HUB_SHARDS.includes(options.shard)) return options.shard;
  const kitchens = normaliseKitchens(options.kitchens);
  if (kitchens.length === 1) return kitchens[0]!;
  return shardForSubject(options.subjectId);
}

/**
 * Forwards a live GET /events/stream request into its shard.
 *
 * The original Request is passed through so the hub sees `Upgrade: websocket`
 * (hibernatable WebSocket transport) and `Last-Event-ID` (resume cursor) —
 * both of which are set by the client, not by us.
 */
export async function connectToHub(
  env: HubEnv,
  options: ConnectOptions,
  request?: Request,
): Promise<Response | null> {
  const shard = shardForConnection(options);
  const stub = getShardStub(env, shard);
  if (!stub) return null;

  const sub: Subscription = {
    subjectId: options.subjectId,
    role: options.role,
    kitchens: normaliseKitchens(options.kitchens),
  };
  const url = new URL("https://order-events-hub/connect");
  url.searchParams.set("subjectId", sub.subjectId);
  url.searchParams.set("role", sub.role);
  url.searchParams.set("kitchens", sub.kitchens.join(","));
  url.searchParams.set("shard", shard);

  const headers = new Headers();
  const upgrade = request?.headers.get("Upgrade");
  if (upgrade) headers.set("Upgrade", upgrade);
  const lastEventId = request?.headers.get("Last-Event-ID");
  if (lastEventId) headers.set("Last-Event-ID", lastEventId);
  // Explicit query cursor wins — WebSocket clients cannot set headers.
  const queryCursor = request ? new URL(request.url).searchParams.get("lastEventId") : null;
  if (queryCursor) url.searchParams.set("lastEventId", queryCursor);

  return stub.fetch(url.toString(), { headers });
}

// ---------------------------------------------------------------------------
// Emitters — stock / menu
// ---------------------------------------------------------------------------

export interface StockChange {
  menuItemId: string;
  /** Absolute level AFTER the change, never a diff. */
  stockQty: number;
  isAvailable?: boolean;
  kitchen?: Kitchen;
}

/**
 * One or more menu items' stock levels moved. Goes to every connection, so a
 * student's menu can patch the affected rows instead of refetching the menu.
 */
export async function emitStockChanged(env: HubEnv, changes: StockChange[]): Promise<void> {
  const items = changes.map<EmitRequestItem>((change) => {
    const delta: StockDelta = {
      kind: "STOCK",
      menuItemId: change.menuItemId,
      stockQty: change.stockQty,
      isAvailable: change.isAvailable ?? change.stockQty > 0,
      ...(change.kitchen ? { kitchen: change.kitchen } : {}),
    };
    return { type: EVENT_MENU_UPDATE, audience: ALL, delta };
  });
  await emit(env, items);
}

/** A menu item was created or edited by an admin. `item` replaces the row. */
export async function emitMenuItemChanged(env: HubEnv, item: MenuItemSummary): Promise<void> {
  await emit(env, [
    { type: EVENT_MENU_UPDATE, audience: ALL, delta: { kind: "ITEM_UPSERT", menuItemId: item.id, item } },
  ]);
}

/** A menu item was deleted. Clients remove the row. */
export async function emitMenuItemRemoved(env: HubEnv, menuItemId: string): Promise<void> {
  await emit(env, [
    { type: EVENT_MENU_UPDATE, audience: ALL, delta: { kind: "ITEM_REMOVED", menuItemId } },
  ]);
}

/** Escape hatch for changes too broad to patch (category reorder, bulk import). */
export async function emitMenuFullRefresh(env: HubEnv, reason?: string): Promise<void> {
  await emit(env, [
    {
      type: EVENT_MENU_UPDATE,
      audience: ALL,
      delta: { kind: "FULL_REFRESH", ...(reason ? { reason } : {}) },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Emitters — order board
// ---------------------------------------------------------------------------

/**
 * A new order landed on a kitchen's board. Carries enough summary for the
 * board to prepend a row without refetching the list.
 *
 * `createOrder()` splits a cart across kitchens, so pass every created order
 * in one call: they are then batched into a single request per shard.
 */
export async function emitOrderCreated(env: HubEnv, orders: OrderSummary[]): Promise<void> {
  const items = orders.map<EmitRequestItem>((order) => ({
    type: EVENT_ORDER_BOARD_UPDATE,
    audience: kitchenAudience(order.kitchen),
    delta: { kind: "ORDER_CREATED", orderId: order.id, order },
  }));
  await emit(env, items);
}

export interface OrderStatusChange {
  orderId: string;
  status: string;
  kitchen: Kitchen;
  previousStatus?: string;
  orderNumber?: number;
  deliveredAt?: Date | string | null;
  /** Student id or guest session id, so the owner gets their own ORDER_UPDATE. */
  subjectId?: string | null;
}

/**
 * An order moved between statuses.
 *
 * Emits TWO frames from one call — the kitchen board's patch (ORDER_BOARD_
 * UPDATE, kitchen-scoped) and the owner's personal notification
 * (ORDER_UPDATE, subject-scoped) — because they have different audiences and
 * different shards. Callers do not have to think about that.
 */
export async function emitOrderStatusChanged(env: HubEnv, change: OrderStatusChange): Promise<void> {
  const updatedAt = new Date().toISOString();
  const deliveredAt =
    change.deliveredAt instanceof Date ? change.deliveredAt.toISOString() : (change.deliveredAt ?? null);

  const boardDelta = {
    kind: "ORDER_STATUS" as const,
    orderId: change.orderId,
    status: change.status,
    kitchen: change.kitchen,
    updatedAt,
    ...(change.previousStatus ? { previousStatus: change.previousStatus } : {}),
    ...(change.orderNumber !== undefined ? { orderNumber: change.orderNumber } : {}),
    deliveredAt,
  };

  const items: EmitRequestItem[] = [
    { type: EVENT_ORDER_BOARD_UPDATE, audience: kitchenAudience(change.kitchen), delta: boardDelta },
  ];

  if (change.subjectId) {
    items.push({
      type: EVENT_ORDER_UPDATE,
      audience: subjectAudience(change.subjectId),
      delta: boardDelta,
      // v1 shape preserved verbatim for un-updated clients.
      legacy: { orderId: change.orderId, status: change.status },
    });
  }

  await emit(env, items);
}

/** An admin opened an order: clears the "new" badge and sets the soft lock. */
export async function emitOrderSeen(
  env: HubEnv,
  params: { orderId: string; kitchen: Kitchen; seenByAdmin: boolean; lockedByAdminId?: string | null },
): Promise<void> {
  await emit(env, [
    {
      type: EVENT_ORDER_BOARD_UPDATE,
      audience: kitchenAudience(params.kitchen),
      delta: {
        kind: "ORDER_SEEN",
        orderId: params.orderId,
        seenByAdmin: params.seenByAdmin,
        lockedByAdminId: params.lockedByAdminId ?? null,
      },
    },
  ]);
}

/** Board-wide resync. Scoped to one kitchen when known, otherwise both. */
export async function emitOrderBoardFullRefresh(
  env: HubEnv,
  kitchen?: Kitchen,
  reason?: string,
): Promise<void> {
  const delta = { kind: "FULL_REFRESH" as const, ...(reason ? { reason } : {}) };
  const audiences: Audience[] = kitchen
    ? [kitchenAudience(kitchen)]
    : [kitchenAudience("SNACKS"), kitchenAudience("MEALS")];
  await emit(
    env,
    audiences.map<EmitRequestItem>((audience) => ({ type: EVENT_ORDER_BOARD_UPDATE, audience, delta })),
  );
}

// ---------------------------------------------------------------------------
// v1 compatibility surface
// ---------------------------------------------------------------------------

export const sseService = {
  /**
   * @deprecated Prefer `connectToHub(env, options, request)` — it carries the
   * role/kitchen needed for shard selection and board filtering.
   */
  async connect(env: HubEnv, userId: string, request?: Request): Promise<Response | null> {
    return connectToHub(env, { subjectId: userId, role: "STUDENT" }, request);
  },

  /** @deprecated Use `emitStockChanged` / `emitMenuItemChanged`. */
  async broadcastMenuUpdate(env: HubEnv): Promise<void> {
    await emitMenuFullRefresh(env, "LEGACY_BROADCAST");
  },

  /** @deprecated Use `emitOrderCreated` / `emitOrderStatusChanged`. */
  async broadcastOrderBoardUpdate(env: HubEnv): Promise<void> {
    await emitOrderBoardFullRefresh(env, undefined, "LEGACY_BROADCAST");
  },

  /**
   * @deprecated Use `emitOrderStatusChanged` — it emits this frame too.
   *
   * `studentId` is nullable because a walk-up guest order has no student
   * behind it. With no subject there is nobody to notify personally, so this
   * no-ops rather than broadcasting one student's order to the whole campus.
   */
  async notifyOrderUpdate(
    env: HubEnv,
    studentId: string | null | undefined,
    orderId: string,
    status: string,
  ): Promise<void> {
    if (!studentId) return;
    await emit(env, [
      {
        type: EVENT_ORDER_UPDATE,
        audience: subjectAudience(studentId),
        delta: {
          kind: "ORDER_STATUS",
          orderId,
          status,
          updatedAt: new Date().toISOString(),
        },
        legacy: { orderId, status },
      },
    ]);
  },

  // v2 surface, also reachable through the object for call sites that already
  // import `sseService` and would rather not add another import.
  emitStockChanged,
  emitMenuItemChanged,
  emitMenuItemRemoved,
  emitMenuFullRefresh,
  emitOrderCreated,
  emitOrderStatusChanged,
  emitOrderSeen,
  emitOrderBoardFullRefresh,
  connectToHub,
  shardForConnection,
};
