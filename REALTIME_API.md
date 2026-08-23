# Realtime API

How to emit real-time deltas from server code, and what clients receive.

- Implementation: `src/services/sseService.ts` (Worker side), `src/durableObjects/orderEventsHub.ts` (hub), `src/lib/realtime.ts` (shared types + constants).
- Client endpoints: `GET /events/stream` (SSE or WebSocket), `GET /events/ws` (WebSocket), `GET /events/meta` (protocol discovery).

---

## 1. The problem this replaces

v1 events carried `{ timestamp }` and nothing else. Every `MENU_UPDATE` meant *"something changed"*, so every connected student answered it with a full `GET /menu`. One order during a lunch rush became one full refetch per connected client — at 200 concurrent users, 200 refetches per order. The kitchen board did the same with the full order list.

v2 payloads carry **what changed**, so clients patch local state. Refetching is now reserved for one explicit signal: `SYNC_REQUIRED`.

**v1 clients keep working.** All three event type names are unchanged, all v1 top-level payload fields are still present, and the v1 function names still exist as thin wrappers. New fields were added, none removed.

---

## 2. Functions to call from `orderService.ts` / `menuService.ts`

All are named exports of `src/services/sseService.ts` and are also reachable as properties of the `sseService` object.

```ts
import {
  emitStockChanged,
  emitOrderCreated,
  emitOrderStatusChanged,
  emitOrderSeen,
  emitMenuItemChanged,
  emitMenuItemRemoved,
  emitMenuFullRefresh,
  emitOrderBoardFullRefresh,
} from "../services/sseService.js";
```

Every function takes `env` first. `env` is the bindings object — `getBindings(c)` in a route, or pass it down from the route into the service. It needs only `ORDER_EVENTS_HUB`; the parameter type is `Pick<Bindings, "ORDER_EVENTS_HUB">`, so `getBindings(c)` satisfies it directly.

**All emits are non-throwing.** If the hub is unreachable the error is logged and swallowed — a real-time hiccup must never fail the order that caused it. If the DO binding is absent (plain Node, e.g. vitest) every emit is a silent no-op.

### Exact signatures

```ts
// --- stock / menu -----------------------------------------------------------

interface StockChange {
  menuItemId: string;
  stockQty: number;              // ABSOLUTE level after the change, never a diff
  isAvailable?: boolean;         // defaults to stockQty > 0
  kitchen?: "SNACKS" | "MEALS";
}
function emitStockChanged(env, changes: StockChange[]): Promise<void>;

interface MenuItemSummary {
  id: string;
  name: string;
  price: string;                 // fixed 2-decimal string, as the REST API serialises it
  stockQty: number;
  isAvailable: boolean;
  imageUrl?: string;
  categoryId?: string;
  kitchen?: "SNACKS" | "MEALS";
}
function emitMenuItemChanged(env, item: MenuItemSummary): Promise<void>;
function emitMenuItemRemoved(env, menuItemId: string): Promise<void>;
function emitMenuFullRefresh(env, reason?: string): Promise<void>;

// --- order board ------------------------------------------------------------

interface OrderSummary {
  id: string;
  orderNumber: number;
  status: string;                // "PENDING" | "PREPARING" | "COOKED" | "DELIVERED"
  kitchen: "SNACKS" | "MEALS";
  totalAmount: string;           // fixed 2-decimal string
  itemCount: number;
  createdAt: string;             // ISO 8601
  studentId?: string | null;     // null for a walk-up guest order
  studentName?: string | null;
  rollNumber?: string | null;
  guestName?: string | null;     // set instead of studentName for guest orders
  collectionAt?: string | null;  // ISO 8601, null = as soon as possible
  seenByAdmin?: boolean;
}
function emitOrderCreated(env, orders: OrderSummary[]): Promise<void>;

interface OrderStatusChange {
  orderId: string;
  status: string;
  kitchen: "SNACKS" | "MEALS";
  previousStatus?: string;
  orderNumber?: number;
  deliveredAt?: Date | string | null;
  subjectId?: string | null;     // studentId, or a guest session id; null => no personal notify
}
function emitOrderStatusChanged(env, change: OrderStatusChange): Promise<void>;

function emitOrderSeen(env, params: {
  orderId: string;
  kitchen: "SNACKS" | "MEALS";
  seenByAdmin: boolean;
  lockedByAdminId?: string | null;
}): Promise<void>;

function emitOrderBoardFullRefresh(env, kitchen?: "SNACKS" | "MEALS", reason?: string): Promise<void>;
```

### Notes that matter

- **`emitOrderCreated` takes an array.** `createOrder()` splits one cart into one order per kitchen. Pass them all in one call; they are batched into a single request per shard instead of one round-trip each.
- **`emitOrderStatusChanged` emits two frames from one call** — the kitchen board patch (`ORDER_BOARD_UPDATE`, kitchen-scoped) and the owner's personal notification (`ORDER_UPDATE`, subject-scoped). You do **not** also need `notifyOrderUpdate`.
- **Stock is only decremented on `DELIVERED`** (`updateOrderStatus`). So the natural place for `emitStockChanged` is the delivery path, alongside `emitOrderStatusChanged` — pass the post-decrement `stockQty` of each affected item.
- **Never pass a Prisma row straight into `OrderSummary`.** The shapes above are hand-written on purpose so a broadcast cannot leak `passwordHash`, the order `token`, or a guest's phone number.

### Suggested wiring

| Site | v1 call | v2 call |
|---|---|---|
| `POST /orders` after `createOrder` | `broadcastMenuUpdate` + `broadcastOrderBoardUpdate` | `emitOrderCreated(env, summaries)` |
| `PATCH /admin/orders/:id/status` | `notifyOrderUpdate` + `broadcastMenuUpdate` + `broadcastOrderBoardUpdate` | `emitOrderStatusChanged(env, change)`, plus `emitStockChanged(env, changes)` when the status is `DELIVERED` |
| `GET /admin/orders/:id` (opens/locks) | `broadcastOrderBoardUpdate` | `emitOrderSeen(env, { orderId, kitchen, seenByAdmin: true, lockedByAdminId })` |
| Admin menu create/update | `broadcastMenuUpdate` | `emitMenuItemChanged(env, item)` |
| Admin menu delete | `broadcastMenuUpdate` | `emitMenuItemRemoved(env, id)` |
| Category reorder, CSV import | `broadcastMenuUpdate` | `emitMenuFullRefresh(env, "CATEGORY_REORDER")` |

Note that `POST /orders` no longer needs a menu event at all: placing an order does not change stock.

### v1 surface (still works, unchanged behaviour)

```ts
sseService.broadcastMenuUpdate(env)                                  // -> MENU_UPDATE       { deltas: [FULL_REFRESH] }
sseService.broadcastOrderBoardUpdate(env)                            // -> ORDER_BOARD_UPDATE { deltas: [FULL_REFRESH] } to both kitchens
sseService.notifyOrderUpdate(env, studentId, orderId, status)        // -> ORDER_UPDATE
sseService.connect(env, userId, request?)                            // -> Response | null
```

`notifyOrderUpdate` now accepts `string | null | undefined` for `studentId` (guest orders have no student) and no-ops when it is absent.

---

## 3. Event payloads on the wire

Every v2 payload carries `v: 2`, `timestamp`, `count` (how many source changes were coalesced), and `deltas`.

### `MENU_UPDATE` — audience: everyone

```json
{
  "v": 2,
  "timestamp": 1755950000000,
  "count": 3,
  "deltas": [
    { "kind": "STOCK", "menuItemId": "9f1c…", "stockQty": 4, "isAvailable": true, "kitchen": "SNACKS" },
    { "kind": "ITEM_UPSERT", "menuItemId": "2a7b…", "item": { "id": "2a7b…", "name": "Veg Puff", "price": "25.00", "stockQty": 40, "isAvailable": true } },
    { "kind": "ITEM_REMOVED", "menuItemId": "c04e…" }
  ]
}
```

`{ "kind": "FULL_REFRESH", "reason": "…" }` may also appear — that one means refetch.

### `ORDER_BOARD_UPDATE` — audience: admins of one kitchen

```json
{
  "v": 2,
  "timestamp": 1755950000000,
  "count": 2,
  "kitchen": "SNACKS",
  "deltas": [
    { "kind": "ORDER_CREATED", "orderId": "b1…", "order": { "id": "b1…", "orderNumber": 1042, "status": "PENDING", "kitchen": "SNACKS", "totalAmount": "70.00", "itemCount": 3, "createdAt": "2026-08-23T06:20:11.000Z", "studentId": "d4…", "studentName": "A. Rao", "rollNumber": "2100031234", "seenByAdmin": false } },
    { "kind": "ORDER_STATUS", "orderId": "a0…", "status": "COOKED", "previousStatus": "PREPARING", "kitchen": "SNACKS", "orderNumber": 1039, "deliveredAt": null, "updatedAt": "2026-08-23T06:20:11.140Z" }
  ]
}
```

`{ "kind": "ORDER_SEEN", "orderId": "…", "seenByAdmin": true, "lockedByAdminId": "…" }` also appears here.

### `ORDER_UPDATE` — audience: one student or one guest session

```json
{
  "v": 2,
  "timestamp": 1755950000000,
  "count": 1,
  "orderId": "a0…",
  "status": "DELIVERED",
  "deltas": [
    { "kind": "ORDER_STATUS", "orderId": "a0…", "status": "DELIVERED", "previousStatus": "COOKED", "kitchen": "SNACKS", "deliveredAt": "2026-08-23T06:20:11.000Z", "updatedAt": "2026-08-23T06:20:11.140Z" }
  ]
}
```

Top-level `orderId` and `status` are the v1 fields, kept verbatim — the current frontend reads `data.status` directly and is unaffected.

### `HELLO` — control, sent once on connect

```json
{ "v": 2, "timestamp": 1755950000000, "count": 0, "shard": "SNACKS", "cursor": 812, "resumed": true, "transport": "sse" }
```

### `SYNC_REQUIRED` — control

```json
{ "v": 2, "timestamp": 1755950000000, "count": 0, "reason": "CURSOR_EXPIRED", "cursor": 812 }
```

The **only** signal that should trigger a full refetch of the menu or the order board. `reason` is `CURSOR_EXPIRED` (offline longer than the retention window) or `CURSOR_AHEAD` (the shard's log was reset).

---

## 4. Client guide

### Transports

| | SSE | WebSocket |
|---|---|---|
| Endpoint | `GET /events/stream?token=…` | `GET /events/stream` or `/events/ws` with `Upgrade: websocket` |
| Framing | `id: <shard>:<seq>` / `event: TYPE` / `data: {…}` | one JSON text frame: `{ "id": "SNACKS:812", "type": "MENU_UPDATE", "data": {…} }` |
| Resume | `Last-Event-ID` header, sent automatically by `EventSource` | `?lastEventId=SNACKS:812` |
| Hibernation | no — an open stream pins the hub in memory | **yes** — preferred transport |
| Heartbeat | `: ping <ts>` comment every 25s | send `"ping"`, runtime replies `"pong"` without waking the hub |

Auth is the existing JWT: `Authorization: Bearer …`, or `?token=…` for browser `EventSource`/`WebSocket`, which cannot set headers.

### Handling events

```ts
switch (type) {
  case "HELLO":          cursor = data.cursor; if (!data.resumed) refetchEverything(); break;
  case "SYNC_REQUIRED":  cursor = data.cursor; refetchEverything(); break;
  case "MENU_UPDATE":
    for (const d of data.deltas) {
      if (d.kind === "STOCK")        patchStock(d.menuItemId, d.stockQty, d.isAvailable);
      if (d.kind === "ITEM_UPSERT")  upsertItem(d.item);
      if (d.kind === "ITEM_REMOVED") removeItem(d.menuItemId);
      if (d.kind === "FULL_REFRESH") refetchMenu();
    }
    break;
  case "ORDER_BOARD_UPDATE":
    for (const d of data.deltas) {
      if (d.kind === "ORDER_CREATED") prependRow(d.order);
      if (d.kind === "ORDER_STATUS")  patchRow(d.orderId, { status: d.status, deliveredAt: d.deliveredAt });
      if (d.kind === "ORDER_SEEN")    patchRow(d.orderId, { seenByAdmin: d.seenByAdmin, lockedByAdminId: d.lockedByAdminId });
      if (d.kind === "FULL_REFRESH")  refetchBoard();
    }
    break;
}
```

`STOCK` carries an **absolute** level, so a duplicated or reordered delta cannot corrupt the client's number. Track the last `id` you processed and send it back as the cursor on reconnect.

`GET /events/meta` returns the protocol version, transports, coalescing window, and resume window if a client wants to feature-detect.

---

## 5. Architecture

### Sharding

One Durable Object per kitchen — `hub:SNACKS`, `hub:MEALS` — replacing the single `idFromName("global")` instance. A DO is a single-threaded process, so the old design serialised every broadcast on the whole campus through one of them.

Connection placement:

| Connection | Shard |
|---|---|
| `ADMIN` with a kitchen | that kitchen's shard |
| `SUPERADMIN` | `SNACKS`, watching both kitchen boards; `?kitchen=` pins them to one |
| `STUDENT` / guest | FNV-1a hash of the subject id, mod 2 — splits the student body evenly |

Frame routing by audience:

| Audience | Shards written | Who receives it |
|---|---|---|
| `ALL` (menu/stock) | both | every connection |
| `KITCHEN` (order board) | that kitchen's | connections whose subscription lists that kitchen — admins only, never students |
| `SUBJECT` (personal) | the subject's hashed shard | that one subject |

`ALL` costs two DO writes instead of one, but each shard then fans out to half the connections, in parallel. Kitchen board traffic — the highest-frequency fan-out during a rush — never crosses shards, so SNACKS and MEALS no longer queue behind each other.

### Coalescing

`emit` does **not** fan out. It appends to a queue persisted in DO storage and arms an alarm `BROADCAST_COALESCE_MS` (**150ms**, `src/lib/realtime.ts`) out. When the alarm fires, everything queued is grouped by `(event type, audience)` and each group becomes **one** frame carrying N deltas.

Within a group, deltas are deduplicated by `(kind, menuItemId | orderId)`, keeping the last — two stock changes to the same item in one window collapse to the later absolute value.

150ms is below the ~250ms threshold at which a UI update starts to feel laggy, while still absorbing a rush: 20 orders/second becomes ~7 fan-outs/second instead of 20, each carrying the batch.

The queue is persisted rather than held in memory because the object can be evicted between accepting a change and flushing it; a DO alarm survives eviction, in-memory state does not.

### Hibernation

WebSocket clients are accepted with `state.acceptWebSocket(ws, tags)` — the WebSocket Hibernation API. An idle hub is evicted from memory while its connections stay open, and the coalescing alarm revives it to fan out. `setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` lets the runtime answer heartbeats without waking the object at all.

Tags (`s:<subjectId>`, `k:<kitchen>`) let a targeted fan-out fetch only the sockets it needs via `getWebSockets(tag)` rather than scanning every connection on the shard. The subscription is stored with `serializeAttachment()` so a revived object still knows who each socket belongs to.

SSE connections cannot hibernate — an open stream pins the object in memory. They remain supported for the existing `EventSource` frontend; resume is what makes an eviction survivable for them.

### Resume

Every frame gets a monotonic per-shard sequence number and is written to a retention log in DO storage, pruned to `EVENT_LOG_MAX_FRAMES` (500) or `EVENT_LOG_TTL_MS` (10 minutes), whichever bites first.

On reconnect the client presents its cursor (`Last-Event-ID` for SSE, `?lastEventId=` for WebSocket). The hub:

1. sends `HELLO` with the shard's current cursor and `resumed: true|false`;
2. if the cursor is still inside the retention window, replays every frame after it that matches this connection's audience, then attaches it live;
3. if the cursor has aged out (or is ahead of the log, i.e. the shard was reset), sends exactly one `SYNC_REQUIRED` and the client refetches once.

Because shard placement is deterministic in the subject id, a reconnecting client always lands back on the shard holding its cursor.

Ten minutes covers a lift, a dead spot between buildings, or a phone that slept through a lecture change — the walking-student case, which previously ended in a silently dead stream.
