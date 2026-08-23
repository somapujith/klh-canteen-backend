# GUEST_REALTIME_PATCH.md

One change is required in a file this workstream does not own. Everything else
for guest realtime — token verification, subject namespacing, the stream
subscription, and the frontend transport — is already in place and needs
nothing from you.

- **Owned and already changed:** `src/routes/events.ts`,
  `src/services/guestSessionService.ts`, and the guest frontend.
- **Needs your hand:** `src/routes/adminOrders.ts` (owned by the order/admin
  workstream).

---

## The change

`PATCH /admin/orders/:id/status` is the only place an order's status moves, and
therefore the only place the owner's personal `ORDER_UPDATE` frame is emitted.
It currently passes `subjectId: order.studentId`, which is `null` on every
walk-up guest order — so a guest's own status change is emitted to the kitchen
board and to nobody else.

`updateOrderStatus()` returns the full `Order` row, so `order.guestSessionId`
is already in hand at that line; no extra query, no signature change.

### Diff

```diff
--- a/src/routes/adminOrders.ts
+++ b/src/routes/adminOrders.ts
@@
 import { emitOrderSeen, emitOrderStatusChanged, emitStockChanged } from "../services/sseService.js";
+import { guestSubjectIdOrNull } from "../services/guestSessionService.js";
@@ adminOrdersRouter.patch("/:id/status", requireAuth("ADMIN"), async (c) => {
   const bindings = getBindings(c);
-  // One call emits both the kitchen-board patch and the owner's personal
-  // notification. Guest orders carry no subject, so they simply get no
-  // targeted push — they poll GET /guest/orders/:id instead.
+  // One call emits both the kitchen-board patch and the owner's personal
+  // notification. An order is owned by exactly one of a student or a guest
+  // session (orderService enforces that), so exactly one of these is non-null.
+  // Guest sessions are namespaced with a `guest:` prefix so a session id can
+  // never collide with, or be spelled as, a student id in the hub's SUBJECT
+  // address space — see guestSessionService.guestSubjectId().
   await emitOrderStatusChanged(bindings, {
     orderId: order.id,
     status: order.status,
     kitchen: order.kitchen,
     orderNumber: order.orderNumber,
     deliveredAt: order.deliveredAt,
-    subjectId: order.studentId,
+    subjectId: order.studentId ?? guestSubjectIdOrNull(order.guestSessionId),
   });
```

### The exact line, for a one-line application

Replace

```ts
    subjectId: order.studentId,
```

with

```ts
    subjectId: order.studentId ?? guestSubjectIdOrNull(order.guestSessionId),
```

and add the import

```ts
import { guestSubjectIdOrNull } from "../services/guestSessionService.js";
```

`guestSubjectIdOrNull` is exported from `src/services/guestSessionService.ts`
and is already on `main`; it returns `null` for a null/absent session id, which
is the value `emitOrderStatusChanged` already treats as "no personal push".

---

## Why it is safe

- **Student orders are untouched.** `order.studentId` is non-null for every
  student order, so `??` short-circuits and the emitted subject is byte-for-byte
  what it is today. A student order and a guest order are mutually exclusive —
  `orderService.resolveOwner()` rejects a payload carrying both, and rejects one
  carrying neither.
- **No widening of any audience.** The `ORDER_BOARD_UPDATE` frame emitted from
  the same call is unchanged; only the second, SUBJECT-scoped frame gains a
  subject it previously lacked.
- **No new data on the wire.** The delta is the one already built for the board
  frame: order id, status, previous status, kitchen, order number, timestamps.
  No guest name, no phone number, no order token.
- **The session id never leaves the server unprefixed, and never leaves it at
  all.** It only becomes a routing key inside the Durable Object. It is not
  echoed in any payload.

## What breaks without it — please read before deferring

This is not a "nice to have half the feature" situation. **Apply this line in
the same deploy as the rest of the guest realtime work.**

`GET /events/stream?guestToken=…` accepts the guest and holds the connection
open, so the frontend sees `connected: true` and — by design, and by the
spec it was written to — stops its 5-second poll. But with `subjectId` still
`order.studentId`, no `ORDER_UPDATE` is ever addressed to a guest subject. The
result is a guest order-status screen that is connected, believes it is live,
and never changes: strictly worse than the polling it replaced.

The frontend cannot detect this on its own. A stream that is connected and
silent is indistinguishable from a stream that is connected and simply has
nothing to say — which is the normal state of a guest waiting for a samosa.
The only thing that separates the two is whether this line has landed.
