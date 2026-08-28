/**
 * In-process realtime hub for plain Node (local dev / non-Workers hosts).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The realtime layer is a Durable Object (src/durableObjects/orderEventsHub.ts).
 * Durable Objects exist only on workerd, so under Node `ORDER_EVENTS_HUB` was
 * unbound and — by design, see sseService.getShardStub — every emit degraded to
 * a silent no-op and `GET /events/stream` answered 503. On Workers that
 * fallback is correct. Under Node it meant the kitchen board never moved: an
 * order was written to the database and nothing ever told the board about it.
 *
 * This class is the same hub for a runtime that has no Durable Objects. It
 * speaks the DO's exact wire contract, so `sseService` and `routes/events.ts`
 * cannot tell the difference and needed no changes:
 *
 *   GET  /connect?subjectId&role&kitchens&shard[&lastEventId]  -> SSE stream
 *   POST /emit       { items: EmitRequestItem[] }              -> 202, coalesced
 *   POST /broadcast  { type, data, userId? }                   -> 202, v1 shim
 *
 * Grouping, dedup and payload shape are NOT reimplemented here — they come from
 * lib/realtime.ts, shared with the DO, so the two hubs cannot drift.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY DIFFERENT FROM THE DURABLE OBJECT
 * ---------------------------------------------------------------------------
 *   STORAGE      The DO persists its pending queue, sequence and frame log to
 *                DO storage so an eviction cannot lose them. A Node process is
 *                not evicted mid-life — it either runs or restarts — so state
 *                is held in memory. A restart resets `seq`, and a client that
 *                reconnects with a higher cursor is told CURSOR_AHEAD and does
 *                one full refetch. That path already existed for DO resets.
 *
 *   COALESCING   setTimeout instead of a DO alarm. Same window, same grouping.
 *
 *   WEBSOCKETS   Not supported: WebSocketPair and the hibernation API are
 *                workerd-only. `/connect` with `Upgrade: websocket` returns 501
 *                rather than pretending. Every browser client uses EventSource
 *                (src/hooks/useSSE.ts), so nothing in this app is affected.
 *
 * ---------------------------------------------------------------------------
 * SCOPE LIMIT — READ BEFORE SCALING THE SERVICE
 * ---------------------------------------------------------------------------
 * Subscribers live in THIS process's memory. That is correct for exactly one
 * instance, which is what a plain-Node process runs. With two instances a
 * client connected to instance A would never see an order placed on instance B.
 * Scaling past one instance means moving fan-out to something shared
 * (Redis pub/sub, or deploying to Workers where the DO already does this).
 * `assertSingleInstance()` below is the tripwire for that.
 */
import {
  BROADCAST_COALESCE_MS,
  EVENT_HELLO,
  EVENT_LOG_MAX_FRAMES,
  EVENT_LOG_TTL_MS,
  EVENT_MENU_UPDATE,
  EVENT_SYNC_REQUIRED,
  REALTIME_PROTOCOL_VERSION,
  SSE_HEARTBEAT_MS,
  buildFramePayload,
  groupEmitItems,
  matchesAudience,
} from "../lib/realtime.js";
import type {
  Audience,
  EmitRequestBody,
  EmitRequestItem,
  HubShard,
  Kitchen,
  RealtimeEventType,
  Subscription,
} from "../lib/realtime.js";

/** A frame as retained for replay. Mirrors the DO's StoredFrame. */
interface StoredFrame {
  seq: number;
  ts: number;
  type: RealtimeEventType;
  audience: Audience;
  /** Already-serialised payload — replay must be byte-identical to live. */
  data: string;
}

interface SseConnection {
  controller: ReadableStreamDefaultController<Uint8Array>;
  sub: Subscription;
  closed: boolean;
}

const encoder = new TextEncoder();

/**
 * One shard's hub. Two of these exist (SNACKS, MEALS), matching the DO's
 * sharding, so a subject hashed to a shard reaches the same set of frames it
 * would on Workers.
 */
class NodeEventsHubShard {
  private readonly shard: HubShard;
  private readonly connections = new Map<number, SseConnection>();
  private readonly frames: StoredFrame[] = [];
  private pending: EmitRequestItem[] = [];
  private seq = 0;
  private nextId = 1;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(shard: HubShard) {
    this.shard = shard;
  }

  /** Live SSE subscriber count. Used by tests and /events/meta diagnostics. */
  get subscriberCount(): number {
    return this.connections.size;
  }

  async fetch(input: string | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/connect") return this.handleConnect(request, url);
    if (request.method === "POST" && url.pathname === "/emit") return this.handleEmit(request);
    if (request.method === "POST" && url.pathname === "/broadcast") return this.handleLegacyBroadcast(request);
    return new Response("Not found", { status: 404 });
  }

  // -------------------------------------------------------------------------
  // Connect
  // -------------------------------------------------------------------------

  private parseSubscription(url: URL): Subscription | null {
    const subjectId = url.searchParams.get("subjectId");
    if (!subjectId) return null;
    const kitchens = (url.searchParams.get("kitchens") ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter((k): k is Kitchen => k === "SNACKS" || k === "MEALS");
    return { subjectId, role: url.searchParams.get("role") ?? "STUDENT", kitchens };
  }

  /** Same cursor rules as the DO: `Last-Event-ID` header or `?lastEventId=`. */
  private parseCursor(request: Request, url: URL): number | null {
    const raw = request.headers.get("Last-Event-ID") ?? url.searchParams.get("lastEventId");
    if (!raw) return null;
    const tail = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
    const parsed = Number.parseInt(tail, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  private handleConnect(request: Request, url: URL): Response {
    const sub = this.parseSubscription(url);
    if (!sub) return new Response("Missing subjectId", { status: 400 });

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      // Not a silent downgrade: a client that asked for WebSocket must learn it
      // did not get one, rather than waiting forever on a socket nobody opened.
      return new Response("WebSocket transport requires the Workers runtime; use SSE", { status: 501 });
    }

    const backlog = this.buildConnectBacklog(sub, this.parseCursor(request, url));
    const id = this.nextId++;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.connections.set(id, { controller, sub, closed: false });
        for (const frame of backlog) this.writeFrame(id, frame);
        this.ensureHeartbeat();
      },
      // Fired when the client disconnects and the response body is torn down.
      cancel: () => this.drop(id),
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Hub-Shard": this.shard,
      },
    });
  }

  /**
   * HELLO, then either the frames the client missed or a single SYNC_REQUIRED
   * when its cursor has aged out of the retention log.
   */
  private buildConnectBacklog(sub: Subscription, cursor: number | null): StoredFrame[] {
    const now = Date.now();
    const missed: StoredFrame[] = [];
    let resumed = false;
    let expired = false;

    if (cursor !== null) {
      const oldest = this.frames.length > 0 ? this.frames[0]!.seq : this.seq + 1;
      if (cursor > this.seq) {
        // Cursor from a previous incarnation of this hub — a process restart
        // rewinds `seq`. Resync rather than replay nothing.
        expired = true;
      } else if (cursor + 1 < oldest) {
        expired = true;
      } else {
        resumed = true;
        for (const frame of this.frames) {
          if (frame.seq > cursor && matchesAudience(sub, frame.audience)) missed.push(frame);
        }
      }
    }

    const hello: StoredFrame = {
      seq: this.seq,
      ts: now,
      type: EVENT_HELLO,
      audience: { scope: "SUBJECT", subjectId: sub.subjectId },
      data: JSON.stringify({
        v: REALTIME_PROTOCOL_VERSION,
        timestamp: now,
        count: 0,
        shard: this.shard,
        cursor: this.seq,
        resumed,
        transport: "sse",
      }),
    };

    if (expired) {
      return [
        hello,
        {
          seq: this.seq,
          ts: now,
          type: EVENT_SYNC_REQUIRED,
          audience: { scope: "SUBJECT", subjectId: sub.subjectId },
          data: JSON.stringify({
            v: REALTIME_PROTOCOL_VERSION,
            timestamp: now,
            count: 0,
            reason: cursor !== null && cursor > this.seq ? "CURSOR_AHEAD" : "CURSOR_EXPIRED",
            cursor: this.seq,
          }),
        },
      ];
    }
    return [hello, ...missed];
  }

  // -------------------------------------------------------------------------
  // Emit + coalescing
  // -------------------------------------------------------------------------

  private async handleEmit(request: Request): Promise<Response> {
    let body: EmitRequestBody;
    try {
      body = (await request.json()) as EmitRequestBody;
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) return new Response(null, { status: 204 });

    this.enqueue(items);
    return new Response(null, { status: 202 });
  }

  /** v1 compatibility: `{ type, data, userId? }` with no delta information. */
  private async handleLegacyBroadcast(request: Request): Promise<Response> {
    const body = (await request.json()) as { type?: string; data?: unknown; userId?: string };
    const audience: Audience = body.userId ? { scope: "SUBJECT", subjectId: body.userId } : { scope: "ALL" };
    this.enqueue([
      {
        type: (body.type as RealtimeEventType) ?? EVENT_MENU_UPDATE,
        audience,
        delta: { kind: "FULL_REFRESH", reason: "LEGACY_BROADCAST" },
        legacy: body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : undefined,
      },
    ]);
    return new Response(null, { status: 202 });
  }

  private enqueue(items: EmitRequestItem[]): void {
    this.pending.push(...items);
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try {
        this.flush();
      } catch (err) {
        // Must never throw: this runs on a timer with no caller to catch it,
        // and a thrown error here would take the process down over a dropped
        // realtime frame.
        console.error(`[hub:${this.shard}] flush failed`, err);
      }
    }, BROADCAST_COALESCE_MS);
    // A pending flush must not hold the process open at shutdown.
    this.flushTimer.unref?.();
  }

  private flush(): void {
    const pending = this.pending;
    this.pending = [];
    if (pending.length === 0) {
      this.prune();
      return;
    }

    const now = Date.now();
    const built: StoredFrame[] = [];
    for (const group of groupEmitItems(pending)) {
      this.seq += 1;
      built.push({
        seq: this.seq,
        ts: now,
        type: group.type,
        audience: group.audience,
        data: JSON.stringify(buildFramePayload(group.type, group.audience, group.items, now)),
      });
    }

    this.frames.push(...built);
    this.prune();
    for (const frame of built) this.deliver(frame);
  }

  // -------------------------------------------------------------------------
  // Fan-out
  // -------------------------------------------------------------------------

  private deliver(frame: StoredFrame): void {
    for (const [id, conn] of [...this.connections]) {
      if (matchesAudience(conn.sub, frame.audience)) this.writeFrame(id, frame);
    }
  }

  private writeFrame(id: number, frame: StoredFrame): void {
    // `id:` is what makes EventSource send Last-Event-ID on reconnect — it is
    // the entire resume mechanism for the SSE transport.
    this.write(id, `id: ${this.shard}:${frame.seq}\nevent: ${frame.type}\ndata: ${frame.data}\n\n`);
  }

  private write(id: number, text: string): void {
    const conn = this.connections.get(id);
    if (!conn || conn.closed) return;
    try {
      conn.controller.enqueue(encoder.encode(text));
    } catch {
      // Controller already closed — the client vanished between our liveness
      // check and this write. Drop it rather than letting it accumulate.
      this.drop(id);
    }
  }

  private drop(id: number): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    conn.closed = true;
    this.connections.delete(id);
    try {
      conn.controller.close();
    } catch {
      /* already closed */
    }
    if (this.connections.size === 0 && this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /** SSE comment frames, so intermediaries do not reap an idle stream. */
  private ensureHeartbeat(): void {
    if (this.heartbeat !== null) return;
    this.heartbeat = setInterval(() => {
      for (const id of [...this.connections.keys()]) this.write(id, `: ping ${Date.now()}\n\n`);
    }, SSE_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /** Drop frames past the count or age limit so memory cannot grow forever. */
  private prune(): void {
    const cutoff = Date.now() - EVENT_LOG_TTL_MS;
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop]!.ts < cutoff) drop += 1;
    const overflow = Math.max(0, this.frames.length - drop - EVENT_LOG_MAX_FRAMES);
    const total = drop + overflow;
    if (total > 0) this.frames.splice(0, total);
  }

  /** Close every stream. Tests and graceful shutdown only. */
  closeAll(): void {
    for (const id of [...this.connections.keys()]) this.drop(id);
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

/**
 * A stand-in for `DurableObjectNamespace` backed by in-process shards.
 *
 * `sseService` addresses the hub as `NAMESPACE.get(NAMESPACE.idFromName(name))`
 * and then calls `.fetch(url, init)` on the stub, so that is exactly the shape
 * reproduced here — the same shape tests/helpers/fakeRateLimiterHub.ts uses for
 * the limiter.
 */
export class NodeEventsHubNamespace {
  private readonly shards = new Map<string, NodeEventsHubShard>();

  private shardFor(name: string): NodeEventsHubShard {
    const existing = this.shards.get(name);
    if (existing) return existing;
    // Names are `hub:<shard>` (sseService.getShardStub). Anything unrecognised
    // still gets a hub rather than throwing — an unknown name is a routing bug,
    // not a reason to fail the order that triggered the emit.
    const shard: HubShard = name.endsWith("MEALS") ? "MEALS" : "SNACKS";
    const created = new NodeEventsHubShard(shard);
    this.shards.set(name, created);
    return created;
  }

  idFromName(name: string): string {
    return name;
  }

  get(name: string): { fetch: (input: string | Request, init?: RequestInit) => Promise<Response> } {
    const shard = this.shardFor(name);
    return { fetch: (input, init) => shard.fetch(input, init) };
  }

  /** Total live SSE subscribers across shards. For diagnostics and tests. */
  get subscriberCount(): number {
    let total = 0;
    for (const shard of this.shards.values()) total += shard.subscriberCount;
    return total;
  }

  closeAll(): void {
    for (const shard of this.shards.values()) shard.closeAll();
  }
}

/**
 * Guard against the one deployment change that would silently break this hub.
 *
 * Fan-out is per-process, so more than one instance means clients miss events
 * that happened on the other one. There is no way to detect sibling instances
 * from inside the process, so this reads the platform's own instance count and
 * warns loudly rather than failing — a noisy log beats a board that is subtly
 * wrong during a lunch rush.
 */
export function assertSingleInstance(log: (message: string) => void = console.warn): void {
  const declared = Number(process.env.WEB_CONCURRENCY ?? process.env.NUM_INSTANCES ?? "1");
  if (Number.isFinite(declared) && declared > 1) {
    log(
      `[hub] ${declared} instances configured, but the Node realtime hub fans out in-process only. ` +
        `Clients on one instance will miss events emitted on another. ` +
        `Move fan-out to Redis or deploy to Workers before scaling past one instance.`,
    );
  }
}

export function createNodeEventsHub(): NodeEventsHubNamespace {
  return new NodeEventsHubNamespace();
}
