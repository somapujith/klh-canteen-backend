/**
 * Durable Object acting as the single real-time SSE broadcast hub.
 *
 * Replaces the old in-memory `Map<userId, Response[]>` from sseService.ts,
 * which relied on Node holding one long-lived process — that assumption
 * breaks on Workers, where each request can land on a different isolate with
 * no shared memory. A Durable Object IS a single durable process, so it can
 * hold live SSE connections the same way the old in-memory map did.
 *
 * Routing (all internal, called only via env.ORDER_EVENTS_HUB from the
 * Worker — see src/services/sseService.ts and src/routes/events.ts):
 *   GET  /connect?userId=<id>  -> opens and holds an SSE stream for a user
 *   POST /broadcast            -> { type, data, userId? } fan-out to one
 *                                  user's connections (userId set) or all
 *                                  connected clients (userId omitted)
 *
 * Event wire format is unchanged from the old service so the frontend's
 * EventSource-based useSSE hook keeps working without changes:
 *   `event: TYPE\ndata: {...}\n\n`
 */
export class OrderEventsHub {
  private clients: Map<string, Set<WritableStreamDefaultWriter<Uint8Array>>> = new Map();

  // Signature required by the Durable Objects runtime; env is unused here
  // since the hub only needs its own in-memory client map.
  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/connect") {
      return this.handleConnect(url);
    }
    if (request.method === "POST" && url.pathname === "/broadcast") {
      return this.handleBroadcast(request);
    }
    return new Response("Not found", { status: 404 });
  }

  private handleConnect(url: URL): Response {
    const userId = url.searchParams.get("userId");
    if (!userId) return new Response("Missing userId", { status: 400 });

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    if (!this.clients.has(userId)) this.clients.set(userId, new Set());
    this.clients.get(userId)!.add(writer);

    // Best-effort cleanup once the client disconnects and the writer's side
    // of the stream closes/errors, mirroring the old `res.on("close", ...)`.
    writer.closed
      .catch(() => {})
      .finally(() => {
        const userClients = this.clients.get(userId);
        userClients?.delete(writer);
        if (userClients && userClients.size === 0) this.clients.delete(userId);
      });

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    const body = await request.json<{ type: string; data: unknown; userId?: string }>();
    const payload = `event: ${body.type}\ndata: ${JSON.stringify(body.data)}\n\n`;
    const encoded = new TextEncoder().encode(payload);

    const targetGroups = body.userId
      ? this.clients.has(body.userId)
        ? [this.clients.get(body.userId)!]
        : []
      : [...this.clients.values()];

    for (const writers of targetGroups) {
      for (const writer of writers) {
        try {
          await writer.write(encoded);
        } catch {
          // Dead connection — drop it rather than let writes keep failing.
          writers.delete(writer);
        }
      }
    }

    return new Response(null, { status: 204 });
  }
}
