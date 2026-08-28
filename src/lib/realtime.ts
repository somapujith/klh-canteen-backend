/**
 * Shared wire contract for the real-time layer.
 *
 * This module is imported by BOTH sides of the hub boundary:
 *   - the Worker  (src/services/sseService.ts, src/routes/events.ts)
 *   - the Durable Object (src/durableObjects/orderEventsHub.ts)
 *
 * It deliberately contains no runtime dependency on Prisma, Hono, or the
 * Workers runtime so either side can import it without dragging the other's
 * dependencies along.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The v1 contract carried `{ timestamp }` and nothing else. Every MENU_UPDATE
 * therefore meant "something, somewhere, changed" and every connected client
 * answered it by refetching the entire menu. One order placed during a lunch
 * rush became one full `GET /menu` per connected student. At 200 concurrent
 * users that is 200 full refetches per order — the single largest scaling
 * defect in the system.
 *
 * v2 keeps the SAME event type names (MENU_UPDATE / ORDER_BOARD_UPDATE /
 * ORDER_UPDATE) and the SAME v1 top-level fields, and ADDS `v: 2` plus a
 * `deltas` array describing exactly what changed. A v1 client that ignores
 * unknown fields keeps working unchanged (it just refetches, as before); a v2
 * client patches local state and never refetches.
 */

/** Kitchens orders are split across. Mirrors the Prisma `Kitchen` enum. */
export type Kitchen = "SNACKS" | "MEALS";

/** Payload version carried on every v2 event. v1 payloads had no `v` field. */
export const REALTIME_PROTOCOL_VERSION = 2 as const;

// ---------------------------------------------------------------------------
// Sharding
// ---------------------------------------------------------------------------

/**
 * The hub is sharded into one Durable Object instance per kitchen instead of
 * the old single `idFromName("global")` instance.
 *
 * A Durable Object is a single-threaded process: every broadcast to every
 * connection campus-wide used to serialise through one of them. Splitting by
 * kitchen means SNACKS fan-out and MEALS fan-out run concurrently in two
 * separate processes, and each holds roughly half the connections.
 */
export const HUB_SHARDS = ["SNACKS", "MEALS"] as const;
export type HubShard = (typeof HUB_SHARDS)[number];

/** Kitchen-scoped traffic lands on that kitchen's shard. */
export function shardForKitchen(kitchen: Kitchen): HubShard {
  return kitchen === "MEALS" ? "MEALS" : "SNACKS";
}

/**
 * Deterministic shard for a connection subject (student id, guest session id).
 *
 * Students watch the menu, not a kitchen board, so they have no natural
 * kitchen. Hashing their id spreads the student population evenly over the two
 * shards, which is the point: 200 students become 2x100 rather than 1x200.
 *
 * It MUST be deterministic — a reconnecting client has to land back on the
 * shard that holds its resume cursor.
 */
export function shardForSubject(subjectId: string): HubShard {
  // FNV-1a, 32-bit. Small, dependency-free, and stable across isolates.
  let hash = 0x811c9dc5;
  for (let i = 0; i < subjectId.length; i++) {
    hash ^= subjectId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return HUB_SHARDS[hash % HUB_SHARDS.length]!;
}

// ---------------------------------------------------------------------------
// Audience — who a frame is for
// ---------------------------------------------------------------------------

/**
 * `ALL`      every connection on the shard (menu/stock changes: all students).
 * `KITCHEN`  connections watching that kitchen's board (kitchen admins).
 * `SUBJECT`  one student or one guest session (their own order's progress).
 */
export type Audience =
  | { scope: "ALL" }
  | { scope: "KITCHEN"; kitchen: Kitchen }
  | { scope: "SUBJECT"; subjectId: string };

/** Stable string form of an audience, used to group deltas during coalescing. */
export function audienceKey(audience: Audience): string {
  switch (audience.scope) {
    case "ALL":
      return "ALL";
    case "KITCHEN":
      return `KITCHEN:${audience.kitchen}`;
    case "SUBJECT":
      return `SUBJECT:${audience.subjectId}`;
  }
}

/** Which shard(s) a frame with this audience has to be written to. */
export function shardsForAudience(audience: Audience): HubShard[] {
  switch (audience.scope) {
    // Menu/stock affects every student, and students are spread over both
    // shards — so this is the one case that costs two DO writes. Each shard
    // then fans out to only half the connections, in parallel.
    case "ALL":
      return [...HUB_SHARDS];
    case "KITCHEN":
      return [shardForKitchen(audience.kitchen)];
    case "SUBJECT":
      return [shardForSubject(audience.subjectId)];
  }
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export const EVENT_MENU_UPDATE = "MENU_UPDATE";
export const EVENT_ORDER_BOARD_UPDATE = "ORDER_BOARD_UPDATE";
export const EVENT_ORDER_UPDATE = "ORDER_UPDATE";
/** Control event: connection accepted. Carries the shard + resume cursor. */
export const EVENT_HELLO = "HELLO";
/**
 * Control event: the client's resume cursor is older than anything the hub
 * still retains, so deltas alone cannot rebuild its state. This is the ONLY
 * situation in which a v2 client should do a full refetch.
 */
export const EVENT_SYNC_REQUIRED = "SYNC_REQUIRED";

export type RealtimeEventType =
  | typeof EVENT_MENU_UPDATE
  | typeof EVENT_ORDER_BOARD_UPDATE
  | typeof EVENT_ORDER_UPDATE
  | typeof EVENT_HELLO
  | typeof EVENT_SYNC_REQUIRED;

// ---------------------------------------------------------------------------
// Deltas — the actual "what changed"
// ---------------------------------------------------------------------------

/** A menu item whose stock level moved. Clients patch `stockQty` in place. */
export interface StockDelta {
  kind: "STOCK";
  menuItemId: string;
  /** Absolute stock level AFTER the change — absolute, not a diff, so a
   *  dropped or reordered delta cannot corrupt the client's number. */
  stockQty: number;
  isAvailable: boolean;
  kitchen?: Kitchen;
}

/** A menu item was created or edited. `item` is the full replacement row. */
export interface MenuItemUpsertDelta {
  kind: "ITEM_UPSERT";
  menuItemId: string;
  item: MenuItemSummary;
}

export interface MenuItemRemovedDelta {
  kind: "ITEM_REMOVED";
  menuItemId: string;
}

/**
 * Emitted by the legacy no-argument wrappers and by changes too broad to
 * express as a patch (e.g. a category was reordered). A v2 client refetches
 * on this and only this.
 */
export interface FullRefreshDelta {
  kind: "FULL_REFRESH";
  reason?: string;
}

export type MenuDelta = StockDelta | MenuItemUpsertDelta | MenuItemRemovedDelta | FullRefreshDelta;

export interface MenuItemSummary {
  id: string;
  name: string;
  price: string;
  stockQty: number;
  isAvailable: boolean;
  imageUrl?: string | null;
  imageHash?: string | null;
  categoryId?: string;
  kitchen?: Kitchen;
}

/**
 * Enough of an order for the kitchen board to render a NEW row without
 * refetching the list. Deliberately a flat, hand-written shape rather than a
 * Prisma row: it must never leak `passwordHash`, `token`, or a guest's phone
 * number to a broadcast.
 */
export interface OrderSummary {
  id: string;
  orderNumber: number;
  status: string;
  kitchen: Kitchen;
  totalAmount: string;
  itemCount: number;
  createdAt: string;
  /** Null for walk-up guest orders. */
  studentId?: string | null;
  studentName?: string | null;
  rollNumber?: string | null;
  /** Set instead of studentName for walk-up guest orders. */
  guestName?: string | null;
  collectionAt?: string | null;
  seenByAdmin?: boolean;
}

export interface OrderCreatedDelta {
  kind: "ORDER_CREATED";
  orderId: string;
  order: OrderSummary;
}

/** Board rows patch status in place; no list refetch. */
export interface OrderStatusDelta {
  kind: "ORDER_STATUS";
  orderId: string;
  status: string;
  previousStatus?: string;
  kitchen?: Kitchen;
  orderNumber?: number;
  deliveredAt?: string | null;
  updatedAt: string;
}

/** An admin opened an order — flips the "new" badge and the soft lock. */
export interface OrderSeenDelta {
  kind: "ORDER_SEEN";
  orderId: string;
  seenByAdmin: boolean;
  lockedByAdminId?: string | null;
}

export type OrderBoardDelta = OrderCreatedDelta | OrderStatusDelta | OrderSeenDelta | FullRefreshDelta;

export type AnyDelta = MenuDelta | OrderBoardDelta;

// ---------------------------------------------------------------------------
// Payloads on the wire
// ---------------------------------------------------------------------------

/**
 * Base v2 payload. `timestamp` is kept from v1 verbatim so an un-updated
 * client that reads `data.timestamp` does not break.
 */
export interface RealtimePayloadBase {
  v: typeof REALTIME_PROTOCOL_VERSION;
  timestamp: number;
  /** How many source changes were coalesced into this frame. */
  count: number;
}

export interface MenuUpdatePayload extends RealtimePayloadBase {
  deltas: MenuDelta[];
}

export interface OrderBoardUpdatePayload extends RealtimePayloadBase {
  kitchen?: Kitchen;
  deltas: OrderBoardDelta[];
}

/**
 * Per-student event. `orderId` and `status` stay at the top level exactly as
 * v1 had them (the current frontend reads `data.status` directly), with the
 * full delta list added alongside.
 */
export interface OrderUpdatePayload extends RealtimePayloadBase {
  orderId: string;
  status: string;
  deltas: OrderStatusDelta[];
}

export interface HelloPayload extends RealtimePayloadBase {
  shard: HubShard;
  cursor: number;
  resumed: boolean;
  transport: "sse" | "ws";
}

export interface SyncRequiredPayload extends RealtimePayloadBase {
  reason: "CURSOR_EXPIRED" | "CURSOR_AHEAD";
  /** Cursor the client should adopt after its one full refetch. */
  cursor: number;
}

// ---------------------------------------------------------------------------
// Hub request bodies (Worker -> Durable Object)
// ---------------------------------------------------------------------------

/** One change submitted to the hub. The hub coalesces these before fan-out. */
export interface EmitRequestItem {
  type: RealtimeEventType;
  audience: Audience;
  delta: AnyDelta;
  /** Extra top-level fields merged into the payload (e.g. ORDER_UPDATE's
   *  legacy `orderId` / `status`). Last writer within a batch wins. */
  legacy?: Record<string, unknown>;
}

export interface EmitRequestBody {
  items: EmitRequestItem[];
}

/** What a connection is allowed to receive, sent by the Worker on connect. */
export interface Subscription {
  subjectId: string;
  role: string;
  /** Kitchen boards this connection watches. Empty for students. */
  kitchens: Kitchen[];
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * Coalescing window. Every change that lands inside this window is merged into
 * a single fan-out carrying N deltas, instead of N separate fan-outs.
 *
 * 150ms sits in the range where the delay is imperceptible on a kitchen board
 * (well under the ~250ms threshold where UI updates start to feel laggy) while
 * still absorbing the burst of a lunch rush: at 20 orders/second it turns 20
 * fan-outs per second into ~7.
 */
export const BROADCAST_COALESCE_MS = 150;

/** Frames retained per shard for resume-after-disconnect. */
export const EVENT_LOG_MAX_FRAMES = 500;

/**
 * How long a resume cursor stays valid. A student walking between buildings on
 * mobile data reconnects within seconds; ten minutes covers a lift, a dead
 * spot, or a phone that slept through a lecture change.
 */
export const EVENT_LOG_TTL_MS = 10 * 60_000;

/** SSE comment heartbeat, to keep proxies from closing an idle stream. */
export const SSE_HEARTBEAT_MS = 25_000;

/** Zero-padded so DO storage's lexicographic `list()` is also numeric order. */
export function frameKey(seq: number): string {
  return `e:${seq.toString().padStart(12, "0")}`;
}

export const FRAME_KEY_PREFIX = "e:";

// ---------------------------------------------------------------------------
// Frame construction, shared by every hub implementation.
//
// There are two hubs: the Durable Object (src/durableObjects/orderEventsHub.ts,
// Workers) and the in-process one (src/services/nodeEventsHub.ts, plain Node).
// They differ only in transport and storage — grouping, dedup and payload shape
// are protocol, not implementation, so they live here. A client cannot tell
// which hub it is talking to, and that is only true if this logic exists once.
// ---------------------------------------------------------------------------

/** Does this subscription receive frames addressed to this audience? */
export function matchesAudience(sub: Subscription, audience: Audience): boolean {
  switch (audience.scope) {
    case "ALL":
      return true;
    case "KITCHEN":
      return sub.kitchens.includes(audience.kitchen);
    case "SUBJECT":
      return sub.subjectId === audience.subjectId;
  }
}

export interface EmitGroup {
  type: RealtimeEventType;
  audience: Audience;
  items: EmitRequestItem[];
}

/**
 * Group queued changes by (event type, audience), preserving first-seen order,
 * so N changes for one audience become ONE frame carrying N deltas.
 */
export function groupEmitItems(items: EmitRequestItem[]): EmitGroup[] {
  const groups = new Map<string, EmitGroup>();
  for (const item of items) {
    const key = `${item.type}|${audienceKey(item.audience)}`;
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { type: item.type, audience: item.audience, items: [item] });
  }
  return [...groups.values()];
}

/**
 * The wire payload for one coalesced frame.
 *
 * Deltas are deduplicated per target: two stock changes to the same item inside
 * one window collapse to the later, absolute value.
 */
export function buildFramePayload(
  type: RealtimeEventType,
  audience: Audience,
  items: EmitRequestItem[],
  now: number,
): Record<string, unknown> {
  const byTarget = new Map<string, EmitRequestItem>();
  for (const item of items) {
    const delta = item.delta as { kind: string; menuItemId?: string; orderId?: string };
    const target = `${delta.kind}:${delta.menuItemId ?? delta.orderId ?? ""}`;
    byTarget.set(target, item);
  }
  const merged = [...byTarget.values()];

  const legacy: Record<string, unknown> = {};
  for (const item of merged) if (item.legacy) Object.assign(legacy, item.legacy);

  const payload: Record<string, unknown> = {
    v: REALTIME_PROTOCOL_VERSION,
    timestamp: now,
    count: merged.length,
    ...legacy,
    deltas: merged.map((item) => item.delta),
  };

  if (type === EVENT_ORDER_BOARD_UPDATE && audience.scope === "KITCHEN") {
    payload.kitchen = audience.kitchen;
  }
  // v1 clients read data.orderId / data.status off ORDER_UPDATE directly; make
  // sure they are always present even if the caller omitted `legacy`.
  if (type === EVENT_ORDER_UPDATE && payload.orderId === undefined) {
    const first = merged[0]?.delta as { orderId?: string; status?: string } | undefined;
    if (first?.orderId) payload.orderId = first.orderId;
    if (first?.status) payload.status = first.status;
  }
  return payload;
}
