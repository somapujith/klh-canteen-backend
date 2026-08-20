import type { Bindings } from "../types.js";

type HubEnv = Pick<Bindings, "ORDER_EVENTS_HUB">;

function getHubStub(env: HubEnv): DurableObjectStub | null {
  if (!env.ORDER_EVENTS_HUB) return null; // no binding (e.g. local Node test run) — caller no-ops
  const id = env.ORDER_EVENTS_HUB.idFromName("global");
  return env.ORDER_EVENTS_HUB.get(id);
}

async function broadcast(env: HubEnv, type: string, data: unknown, userId?: string): Promise<void> {
  const stub = getHubStub(env);
  if (!stub) return;
  await stub.fetch("https://order-events-hub/broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, data, userId }),
  });
}

export const sseService = {
  /** Forwards a live GET /events/stream connection into the DO's hold-open SSE stream. */
  async connect(env: HubEnv, userId: string): Promise<Response | null> {
    const stub = getHubStub(env);
    if (!stub) return null;
    return stub.fetch(`https://order-events-hub/connect?userId=${encodeURIComponent(userId)}`);
  },

  async broadcastMenuUpdate(env: HubEnv): Promise<void> {
    await broadcast(env, "MENU_UPDATE", { timestamp: Date.now() });
  },

  async broadcastOrderBoardUpdate(env: HubEnv): Promise<void> {
    await broadcast(env, "ORDER_BOARD_UPDATE", { timestamp: Date.now() });
  },

  async notifyOrderUpdate(env: HubEnv, studentId: string, orderId: string, status: string): Promise<void> {
    await broadcast(env, "ORDER_UPDATE", { orderId, status, timestamp: Date.now() }, studentId);
  },
};
