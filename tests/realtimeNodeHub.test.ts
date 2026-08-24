/**
 * The realtime chain under plain Node, end to end.
 *
 * WHAT THIS PROVES. A student places an order over the real HTTP API, and an
 * admin already holding an open `GET /events/stream` receives an
 * ORDER_BOARD_UPDATE frame carrying an ORDER_CREATED delta — without polling
 * and without reconnecting. That is the behaviour that was broken on Render:
 * ORDER_EVENTS_HUB is a Durable Object, so under Node it was unbound, every
 * emit no-opped, /events/stream answered 503, and the kitchen board never
 * moved.
 *
 * WHY IT IS NOT A FAKE TEST. Nothing between the HTTP request and the SSE
 * frame is stubbed: the route, the order service, sseService's shard routing
 * and the hub's coalescing all run for real. The only substitution is the hub
 * implementation itself (services/nodeEventsHub.ts) — which is the production
 * code path on Render, not a test double. Delete the hub wiring and these
 * tests fail.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach } from "vitest";

import { describeDb, getTestPrisma, resetDatabase, disconnectTestPrisma, testDb } from "./helpers/db.js";
import { createApp } from "../src/app.js";
import { createStudent, createAdmin, createMenuItem, tokenFor } from "./helpers/app.js";
import { createNodeEventsHub, type NodeEventsHubNamespace } from "../src/services/nodeEventsHub.js";

const prisma = testDb.enabled ? getTestPrisma() : (undefined as any);
const app = createApp();

let hub: NodeEventsHubNamespace;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`http://test.local${path}`, init),
      { ORDER_EVENTS_HUB: hub } as any,
      { waitUntil() {}, passThroughOnException() {} } as any,
    ),
  );
}

interface SseFrame {
  event: string;
  id?: string;
  data: any;
}

/**
 * Reads SSE frames off a live response body until `predicate` is satisfied or
 * the timeout elapses. Returns every frame seen, so a test can assert on the
 * HELLO handshake as well as the frame it was waiting for.
 */
async function readFramesUntil(
  response: Response,
  predicate: (frame: SseFrame) => boolean,
  timeoutMs = 4000,
): Promise<SseFrame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const timeout = new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
        // Never hold the process open on this timer.
        (t as any).unref?.();
      });
      const chunk = await Promise.race([reader.read(), timeout]);
      if (!chunk || chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        if (!block.trim() || block.startsWith(":")) continue; // heartbeat comment
        const frame: SseFrame = { event: "message", data: undefined };
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) frame.event = line.slice(7);
          else if (line.startsWith("id: ")) frame.id = line.slice(4);
          else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
        }
        frames.push(frame);
        if (predicate(frame)) return frames;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

async function placeOrder(token: string, menuItemId: string, qty = 1) {
  return call("/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ items: [{ menuItemId, qty }] }),
  });
}

beforeEach(async () => {
  hub = createNodeEventsHub();
  if (testDb.enabled) await resetDatabase();
});

afterEach(() => {
  hub?.closeAll();
});

afterAll(async () => {
  if (testDb.enabled) await disconnectTestPrisma();
});

describeDb("realtime hub under Node", () => {
  it("streams instead of 503ing once the hub is bound", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const res = await call(`/events/stream?token=${tokenFor(admin)}&kitchen=SNACKS`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const frames = await readFramesUntil(res, (f) => f.event === "HELLO");
    const hello = frames.find((f) => f.event === "HELLO");
    expect(hello).toBeDefined();
    expect(hello!.data.v).toBe(2);
    expect(hello!.data.transport).toBe("sse");
  });

  it("delivers a new student order to a connected admin board with no refetch", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const student = await createStudent();
    const item = await createMenuItem({ kitchen: "SNACKS", price: "20.00", stockQty: 10 });

    const stream = await call(`/events/stream?token=${tokenFor(admin)}&kitchen=SNACKS`);
    expect(stream.status).toBe(200);

    // Wait for HELLO so the subscription is registered before the order lands;
    // otherwise the test could race the connect and pass for the wrong reason.
    const collected = readFramesUntil(
      stream,
      (f) => f.event === "ORDER_BOARD_UPDATE",
      6000,
    );

    const placed = await placeOrder(tokenFor(student), item.id, 2);
    expect(placed.status).toBe(201);

    const frames = await collected;
    const board = frames.find((f) => f.event === "ORDER_BOARD_UPDATE");
    expect(board, `no ORDER_BOARD_UPDATE; saw ${frames.map((f) => f.event).join(", ")}`).toBeDefined();

    expect(board!.data.v).toBe(2);
    expect(board!.data.kitchen).toBe("SNACKS");
    const created = (board!.data.deltas as any[]).find((d) => d.kind === "ORDER_CREATED");
    expect(created).toBeDefined();
    expect(created.order.status).toBe("PENDING");
    expect(created.order.studentId).toBe(student.id);
    // The frame id is the resume cursor — without it EventSource cannot resume.
    expect(board!.id).toMatch(/^SNACKS:\d+$/);
  });

  it("does not leak one kitchen's board to the other kitchen's admin", async () => {
    const mealsAdmin = await createAdmin({ kitchen: "MEALS" });
    const student = await createStudent();
    const snacksItem = await createMenuItem({ kitchen: "SNACKS", stockQty: 10 });
    const mealsItem = await createMenuItem({ kitchen: "MEALS", stockQty: 10 });
    const token = tokenFor(student);

    const stream = await call(`/events/stream?token=${tokenFor(mealsAdmin)}&kitchen=MEALS`);

    // Both orders are placed, but only the MEALS one may arrive. Waiting for
    // the MEALS frame is what stops this from passing vacuously: a test that
    // only asserted "nothing arrived" would also pass with the hub switched
    // off entirely, proving nothing about isolation.
    const collected = readFramesUntil(
      stream,
      (f) => f.event === "ORDER_BOARD_UPDATE" && f.data.kitchen === "MEALS",
      6000,
    );

    await placeOrder(token, snacksItem.id);
    await placeOrder(token, mealsItem.id);

    const frames = await collected;
    const boardFrames = frames.filter((f) => f.event === "ORDER_BOARD_UPDATE");
    expect(boardFrames.length).toBeGreaterThan(0);
    expect(boardFrames.every((f) => f.data.kitchen === "MEALS")).toBe(true);
  });

  it("coalesces a burst of orders into fewer frames than orders", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const student = await createStudent();
    const item = await createMenuItem({ kitchen: "SNACKS", stockQty: 50 });
    const token = tokenFor(student);

    const stream = await call(`/events/stream?token=${tokenFor(admin)}&kitchen=SNACKS`);
    const collected = readFramesUntil(
      stream,
      (f) => f.event === "ORDER_BOARD_UPDATE" && (f.data.count as number) >= 3,
      6000,
    );

    // Inside one coalescing window these must arrive as one frame carrying
    // several deltas, not one frame each — that is the whole point of the
    // window, and the reason the board survives a lunch rush.
    await Promise.all([
      placeOrder(token, item.id),
      placeOrder(token, item.id),
      placeOrder(token, item.id),
    ]);

    const frames = await collected;
    const boardFrames = frames.filter((f) => f.event === "ORDER_BOARD_UPDATE");
    const totalDeltas = boardFrames.reduce(
      (sum, f) => sum + (f.data.deltas as any[]).filter((d) => d.kind === "ORDER_CREATED").length,
      0,
    );
    expect(totalDeltas).toBe(3);
    expect(boardFrames.length).toBeLessThan(3);
  });

  it("pushes a status change to the student who placed the order", async () => {
    // The point of the whole chain, from the student's side: they are standing
    // at the counter watching their token, the kitchen marks it cooked, and the
    // screen has to move on its own. The board's KITCHEN-scoped frame is no use
    // to them — this asserts the separate owner-scoped ORDER_UPDATE.
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const student = await createStudent();
    const item = await createMenuItem({ kitchen: "SNACKS", stockQty: 10 });
    const studentToken = tokenFor(student);

    const placed = await placeOrder(studentToken, item.id);
    expect(placed.status).toBe(201);
    const orderId = ((await placed.json()) as any[])[0].id;

    const stream = await call(`/events/stream?token=${studentToken}`);
    expect(stream.status).toBe(200);
    const collected = readFramesUntil(stream, (f) => f.event === "ORDER_UPDATE", 6000);

    const patched = await call(`/admin/orders/${orderId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(admin)}` },
      body: JSON.stringify({ status: "COOKED" }),
    });
    expect(patched.status).toBe(200);

    const frames = await collected;
    const update = frames.find((f) => f.event === "ORDER_UPDATE");
    expect(update, `no ORDER_UPDATE; saw ${frames.map((f) => f.event).join(", ")}`).toBeDefined();

    const delta = (update!.data.deltas as any[]).find((d) => d.kind === "ORDER_STATUS");
    expect(delta).toBeDefined();
    expect(delta.orderId).toBe(orderId);
    expect(delta.status).toBe("COOKED");
    // v1 clients read these off the payload directly; they must not disappear.
    expect(update!.data.orderId).toBe(orderId);
    expect(update!.data.status).toBe("COOKED");
  });

  it("does not leak one student's order update to another student", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const owner = await createStudent();
    const bystander = await createStudent();
    const item = await createMenuItem({ kitchen: "SNACKS", stockQty: 10 });

    const placed = await placeOrder(tokenFor(owner), item.id);
    const orderId = ((await placed.json()) as any[])[0].id;

    const stream = await call(`/events/stream?token=${tokenFor(bystander)}`);
    const collected = readFramesUntil(stream, (f) => f.event === "ORDER_UPDATE", 2500);

    await call(`/admin/orders/${orderId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(admin)}` },
      body: JSON.stringify({ status: "COOKED" }),
    });

    const frames = await collected;
    expect(frames.some((f) => f.event === "ORDER_UPDATE")).toBe(false);
  });

  it("tells a client with an impossible cursor to resync rather than replaying nothing", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    // A cursor from a previous process: this hub's seq is 0, so 999 is ahead.
    const res = await call(`/events/stream?token=${tokenFor(admin)}&kitchen=SNACKS&lastEventId=SNACKS:999`);
    const frames = await readFramesUntil(res, (f) => f.event === "SYNC_REQUIRED");

    const sync = frames.find((f) => f.event === "SYNC_REQUIRED");
    expect(sync).toBeDefined();
    expect(sync!.data.reason).toBe("CURSOR_AHEAD");
  });

  it("drops the subscription when the client disconnects", async () => {
    const admin = await createAdmin({ kitchen: "SNACKS" });
    const res = await call(`/events/stream?token=${tokenFor(admin)}&kitchen=SNACKS`);

    // Sampled inside the predicate, while the stream is still open:
    // readFramesUntil cancels the reader when it returns, and that cancel IS
    // the disconnect under test.
    let subscribersWhileConnected = -1;
    await readFramesUntil(res, (f) => {
      if (f.event === "HELLO") subscribersWhileConnected = hub.subscriberCount;
      return f.event === "HELLO";
    });

    expect(subscribersWhileConnected).toBe(1);
    // The cancel callback runs on the stream's own microtask.
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.subscriberCount).toBe(0);
  });
});
