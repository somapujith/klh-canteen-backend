/**
 * Durable Object backing the real-time layer.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED FROM v1, AND WHY
 * ---------------------------------------------------------------------------
 * v1 was a single instance — `idFromName("global")` — holding every live SSE
 * connection campus-wide in a plain in-memory `Map`, fanning out one write per
 * connection per change, carrying no data. Three defects followed from that:
 *
 *   1. One process for the whole campus. A DO is single-threaded, so SNACKS
 *      traffic and MEALS traffic queued behind each other.
 *   2. No coalescing. N orders in a second produced N full fan-outs, and each
 *      fan-out told every client "something changed" — provoking a full
 *      refetch of the menu or the order board from every one of them.
 *   3. In-memory only, no hibernation, no resume. An eviction silently dropped
 *      every connection, and a reconnecting client had no way to learn what it
 *      had missed — a student walking between buildings just stopped getting
 *      updates, with no error anywhere.
 *
 * v2 fixes all three:
 *
 *   SHARDING     One instance per kitchen (`SNACKS` / `MEALS`) — see
 *                shardForKitchen()/shardForSubject() in src/lib/realtime.ts.
 *                Kitchen boards land on their own kitchen's shard; students
 *                are hashed evenly across both.
 *
 *   COALESCING   /emit does NOT fan out. It appends to a persisted pending
 *                queue and arms a BROADCAST_COALESCE_MS alarm. The alarm
 *                groups everything that landed in the window by
 *                (event type, audience) and emits ONE frame per group
 *                carrying N deltas. 20 orders/second becomes ~7 fan-outs.
 *
 *   HIBERNATION  WebSocket clients are accepted with
 *                `state.acceptWebSocket()` (the WebSocket Hibernation API), so
 *                an idle hub is evicted from memory while its connections stay
 *                open, and is revived by the coalescing alarm to fan out. Ping
 *                heartbeats are answered by the runtime via
 *                setWebSocketAutoResponse() without waking the object at all.
 *
 *   RESUME       Every frame gets a monotonic per-shard sequence number and is
 *                written to a retention log in DO storage. A reconnecting
 *                client presents `Last-Event-ID` (EventSource sends this
 *                automatically) or `?lastEventId=`, and the hub replays the
 *                frames it missed before attaching it live. If the cursor is
 *                older than the retention window the client gets exactly one
 *                SYNC_REQUIRED telling it to do a full refetch — the only
 *                circumstance under which a v2 client refetches at all.
 *
 * ---------------------------------------------------------------------------
 * ROUTING (internal; reached only via env.ORDER_EVENTS_HUB from the Worker —
 * see src/services/sseService.ts and src/routes/events.ts)
 * ---------------------------------------------------------------------------
 *   GET  /connect?subjectId&role&kitchens&lastEventId
 *        Upgrade: websocket -> hibernatable WebSocket
 *        otherwise           -> held-open SSE stream
 *   POST /emit       { items: EmitRequestItem[] }  -> queued, coalesced
 *   POST /broadcast  { type, data, userId? }       -> v1 compatibility shim
 */
import {
  BROADCAST_COALESCE_MS,
  EVENT_HELLO,
  EVENT_LOG_MAX_FRAMES,
  EVENT_LOG_TTL_MS,
  EVENT_MENU_UPDATE,
  EVENT_ORDER_BOARD_UPDATE,
  EVENT_ORDER_UPDATE,
  EVENT_SYNC_REQUIRED,
  FRAME_KEY_PREFIX,
  REALTIME_PROTOCOL_VERSION,
  SSE_HEARTBEAT_MS,
  buildFramePayload,
  frameKey,
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

/** DO storage key holding the last assigned frame sequence number. */
const KEY_SEQ = "seq";
/** DO storage key holding changes accepted but not yet coalesced+flushed. */
const KEY_PENDING = "pending";

/** A frame as retained for replay. */
interface StoredFrame {
  seq: number;
  ts: number;
  type: RealtimeEventType;
  audience: Audience;
  /** Already-serialised payload — replay must be byte-identical to live. */
  data: string;
}

/** A live SSE connection. SSE cannot hibernate; see the class docstring. */
interface SseConnection {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  sub: Subscription;
  /** Frames handed to the writer that have not drained yet. */
  queued: number;
  dead: boolean;
}

/**
 * How many undrained frames a single SSE client may accumulate before it is
 * dropped as stalled.
 *
 * This limit is load-bearing, not a nicety. A client that vanishes without a
 * TCP reset (a phone that walked out of range — precisely the case this hub
 * exists to survive) leaves a writer whose `write()` promise never settles.
 * The v1 hub awaited every write inside the fan-out loop, so one such client
 * silently stalled every broadcast to every other client on the shard. Writes
 * are now never awaited during fan-out, and a client that stops draining is
 * disconnected instead of being allowed to jam the hub.
 */
const SSE_MAX_QUEUED_FRAMES = 64;

const encoder = new TextEncoder();

export class OrderEventsHub {
  private readonly state: DurableObjectState;
  /** Set on the first request; the shard's own name, for frame ids. */
  private shard: HubShard = "SNACKS";
  private readonly sseClients = new Map<number, SseConnection>();
  private nextSseId = 1;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;

    // Answer client keep-alive pings in the runtime, without waking a
    // hibernating object. Without this every heartbeat would defeat
    // hibernation entirely.
    try {
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch {
      // Older runtimes without the auto-response API: heartbeats still work,
      // they just wake the object. Not worth failing construction over.
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const shardParam = url.searchParams.get("shard");
    if (shardParam === "SNACKS" || shardParam === "MEALS") this.shard = shardParam;

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
    const kitchensRaw = url.searchParams.get("kitchens") ?? "";
    const kitchens = kitchensRaw
      .split(",")
      .map((k) => k.trim())
      .filter((k): k is Kitchen => k === "SNACKS" || k === "MEALS");
    return { subjectId, role: url.searchParams.get("role") ?? "STUDENT", kitchens };
  }

  /**
   * Resume cursor from `Last-Event-ID` (sent automatically by EventSource on
   * reconnect) or an explicit `?lastEventId=`. Frame ids are `<shard>:<seq>`;
   * a bare number is accepted too. Returns null when the client is new.
   */
  private parseCursor(request: Request, url: URL): number | null {
    const raw = request.headers.get("Last-Event-ID") ?? url.searchParams.get("lastEventId");
    if (!raw) return null;
    const tail = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
    const parsed = Number.parseInt(tail, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  private async handleConnect(request: Request, url: URL): Promise<Response> {
    const sub = this.parseSubscription(url);
    if (!sub) return new Response("Missing subjectId", { status: 400 });
    const cursor = this.parseCursor(request, url);

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketConnect(sub, cursor);
    }
    return this.handleSseConnect(sub, cursor);
  }

  private async handleWebSocketConnect(sub: Subscription, cursor: number | null): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Tags let a targeted fan-out fetch only the sockets it needs
    // (getWebSockets("s:<id>")) instead of scanning every connection.
    const tags = [`s:${sub.subjectId}`, ...sub.kitchens.map((k) => `k:${k}`)];
    this.state.acceptWebSocket(server, tags);
    // Survives hibernation, so a revived object still knows who this is.
    server.serializeAttachment(sub);

    const backlog = await this.buildConnectBacklog(sub, cursor, "ws");
    for (const frame of backlog) {
      try {
        server.send(JSON.stringify({ id: `${this.shard}:${frame.seq}`, type: frame.type, data: JSON.parse(frame.data) }));
      } catch {
        break;
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleSseConnect(sub: Subscription, cursor: number | null): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const id = this.nextSseId++;
    this.sseClients.set(id, { writer, sub, queued: 0, dead: false });
    this.ensureHeartbeat();

    // Writes are queued in order by the WritableStream itself, so the backlog
    // arrives before any live frame without this having to await anything.
    const backlog = await this.buildConnectBacklog(sub, cursor, "sse");
    for (const frame of backlog) this.writeSse(id, frame);

    writer.closed
      .catch(() => {})
      .finally(() => this.dropSse(id));

    return new Response(readable, {
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
  private async buildConnectBacklog(
    sub: Subscription,
    cursor: number | null,
    transport: "sse" | "ws",
  ): Promise<StoredFrame[]> {
    const seq = ((await this.state.storage.get<number>(KEY_SEQ)) ?? 0);
    const frames: StoredFrame[] = [];
    let resumed = false;
    let expired = false;

    if (cursor !== null) {
      const retained = await this.listFrames();
      const oldest = retained.length > 0 ? retained[0]!.seq : seq + 1;
      if (cursor > seq) {
        // Cursor from a previous incarnation of this shard's log (a DO reset
        // rewinds `seq`). Treat as a resync rather than replaying nothing.
        expired = true;
      } else if (cursor + 1 < oldest) {
        expired = true;
      } else {
        resumed = true;
        for (const frame of retained) {
          if (frame.seq > cursor && matchesAudience(sub, frame.audience)) frames.push(frame);
        }
      }
    }

    const hello: StoredFrame = {
      seq,
      ts: Date.now(),
      type: EVENT_HELLO,
      audience: { scope: "SUBJECT", subjectId: sub.subjectId },
      data: JSON.stringify({
        v: REALTIME_PROTOCOL_VERSION,
        timestamp: Date.now(),
        count: 0,
        shard: this.shard,
        cursor: seq,
        resumed,
        transport,
      }),
    };

    if (expired) {
      const sync: StoredFrame = {
        seq,
        ts: Date.now(),
        type: EVENT_SYNC_REQUIRED,
        audience: { scope: "SUBJECT", subjectId: sub.subjectId },
        data: JSON.stringify({
          v: REALTIME_PROTOCOL_VERSION,
          timestamp: Date.now(),
          count: 0,
          reason: cursor !== null && cursor > seq ? "CURSOR_AHEAD" : "CURSOR_EXPIRED",
          cursor: seq,
        }),
      };
      return [hello, sync];
    }
    return [hello, ...frames];
  }

  // -------------------------------------------------------------------------
  // Emit + coalescing
  // -------------------------------------------------------------------------

  private async handleEmit(request: Request): Promise<Response> {
    let body: EmitRequestBody;
    try {
      body = await request.json<EmitRequestBody>();
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) return new Response(null, { status: 204 });

    await this.enqueue(items);
    return new Response(null, { status: 202 });
  }

  /** v1 compatibility: `{ type, data, userId? }` with no delta information. */
  private async handleLegacyBroadcast(request: Request): Promise<Response> {
    const body = await request.json<{ type: string; data?: unknown; userId?: string }>();
    const audience: Audience = body.userId ? { scope: "SUBJECT", subjectId: body.userId } : { scope: "ALL" };
    await this.enqueue([
      {
        type: (body.type as RealtimeEventType) ?? EVENT_MENU_UPDATE,
        audience,
        delta: { kind: "FULL_REFRESH", reason: "LEGACY_BROADCAST" },
        legacy: (body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : undefined),
      },
    ]);
    return new Response(null, { status: 202 });
  }

  /**
   * Persist the changes and arm the coalescing alarm. Persisting matters: the
   * object can be evicted between accepting a change and flushing it, and an
   * alarm survives eviction while in-memory state does not.
   */
  private async enqueue(items: EmitRequestItem[]): Promise<void> {
    const pending = (await this.state.storage.get<EmitRequestItem[]>(KEY_PENDING)) ?? [];
    await this.state.storage.put(KEY_PENDING, [...pending, ...items]);

    const existing = await this.state.storage.getAlarm();
    // Re-arm when nothing is scheduled, or when the scheduled time is already
    // well past — a stale timestamp means the previous flush did not complete,
    // and without this the queue would never drain again.
    if (existing === null || existing < Date.now() - BROADCAST_COALESCE_MS * 4) {
      await this.state.storage.setAlarm(Date.now() + BROADCAST_COALESCE_MS);
    }
  }

  /**
   * Coalescing window elapsed: group everything queued and fan out once.
   *
   * This must never throw. A rejected alarm handler is retried by the runtime
   * with backoff, and while a retry is outstanding `getAlarm()` keeps
   * reporting a scheduled alarm — so one bad flush would stop every subsequent
   * broadcast on the shard rather than just losing its own batch.
   */
  async alarm(): Promise<void> {
    try {
      await this.flush();
    } catch (err) {
      console.error(`[hub:${this.shard}] flush failed`, err);
    }

    // An emit that landed while this handler was running would have seen an
    // alarm already scheduled (this one) and skipped arming a new one. Arm it
    // here so those changes are not stranded until the next unrelated emit.
    const leftover = (await this.state.storage.get<EmitRequestItem[]>(KEY_PENDING)) ?? [];
    if (leftover.length > 0 && (await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + BROADCAST_COALESCE_MS);
    }
  }

  private async flush(): Promise<void> {
    const pending = (await this.state.storage.get<EmitRequestItem[]>(KEY_PENDING)) ?? [];
    await this.state.storage.delete(KEY_PENDING);
    if (pending.length === 0) {
      await this.prune();
      return;
    }

    const groups = groupEmitItems(pending);

    let seq = (await this.state.storage.get<number>(KEY_SEQ)) ?? 0;
    const now = Date.now();
    const frames: StoredFrame[] = [];
    const writes: Record<string, StoredFrame> = {};

    for (const group of groups) {
      seq += 1;
      const frame: StoredFrame = {
        seq,
        ts: now,
        type: group.type,
        audience: group.audience,
        data: JSON.stringify(buildFramePayload(group.type, group.audience, group.items, now)),
      };
      frames.push(frame);
      writes[frameKey(seq)] = frame;
    }

    await this.state.storage.put({ ...writes, [KEY_SEQ]: seq } as Record<string, unknown>);
    await this.prune();

    for (const frame of frames) this.deliver(frame);
  }

  // -------------------------------------------------------------------------
  // Fan-out
  // -------------------------------------------------------------------------

  /** Fan out one frame. Synchronous by design: nothing here may block the
   *  coalescing alarm on a client's network. */
  private deliver(frame: StoredFrame): void {
    // Targeted frames pull only that subject's sockets by tag rather than
    // walking every connection on the shard.
    const sockets =
      frame.audience.scope === "SUBJECT"
        ? this.state.getWebSockets(`s:${frame.audience.subjectId}`)
        : frame.audience.scope === "KITCHEN"
          ? this.state.getWebSockets(`k:${frame.audience.kitchen}`)
          : this.state.getWebSockets();

    const wsMessage = JSON.stringify({
      id: `${this.shard}:${frame.seq}`,
      type: frame.type,
      data: JSON.parse(frame.data),
    });
    for (const ws of sockets) {
      try {
        ws.send(wsMessage);
      } catch {
        try {
          ws.close(1011, "send failed");
        } catch {
          /* already gone */
        }
      }
    }

    for (const [id, conn] of [...this.sseClients]) {
      if (matchesAudience(conn.sub, frame.audience)) this.writeSse(id, frame);
    }
  }

  /**
   * Hand one frame to an SSE client. Deliberately synchronous and never
   * awaited — see SSE_MAX_QUEUED_FRAMES. WritableStream preserves write order,
   * so not awaiting costs nothing in ordering.
   */
  private writeSse(id: number, frame: StoredFrame): void {
    const conn = this.sseClients.get(id);
    if (!conn || conn.dead) return;
    if (conn.queued >= SSE_MAX_QUEUED_FRAMES) {
      this.dropSse(id);
      return;
    }
    // `id:` is what makes EventSource send Last-Event-ID on reconnect — it is
    // the entire resume mechanism for the SSE transport.
    const text = `id: ${this.shard}:${frame.seq}\nevent: ${frame.type}\ndata: ${frame.data}\n\n`;
    conn.queued += 1;
    conn.writer.write(encoder.encode(text)).then(
      () => {
        conn.queued -= 1;
      },
      () => this.dropSse(id),
    );
  }

  private dropSse(id: number): void {
    const conn = this.sseClients.get(id);
    if (!conn) return;
    conn.dead = true;
    this.sseClients.delete(id);
    try {
      void conn.writer.close().catch(() => {});
    } catch {
      /* already closed */
    }
    if (this.sseClients.size === 0 && this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /** SSE comment frames, so intermediaries do not reap an idle stream. */
  private ensureHeartbeat(): void {
    if (this.heartbeat !== null) return;
    this.heartbeat = setInterval(() => {
      const beat = encoder.encode(`: ping ${Date.now()}\n\n`);
      for (const [id, conn] of [...this.sseClients]) {
        if (conn.queued >= SSE_MAX_QUEUED_FRAMES) {
          this.dropSse(id);
          continue;
        }
        conn.queued += 1;
        conn.writer.write(beat).then(
          () => {
            conn.queued -= 1;
          },
          () => this.dropSse(id),
        );
      }
    }, SSE_HEARTBEAT_MS);
  }

  // -------------------------------------------------------------------------
  // Hibernation callbacks
  // -------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    // "ping" is normally handled by setWebSocketAutoResponse without waking
    // this object at all; this is the fallback path.
    if (message === "ping") {
      try {
        ws.send("pong");
      } catch {
        /* closing */
      }
      return;
    }
    try {
      const parsed = JSON.parse(message) as { type?: string };
      if (parsed.type === "ping") ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
    } catch {
      /* not JSON — ignore rather than kill the connection */
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    try {
      // 1006 is synthesised for abnormal closure and cannot be echoed back.
      ws.close(code === 1006 ? 1000 : code, "closing");
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      /* already closed */
    }
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  private async listFrames(): Promise<StoredFrame[]> {
    const map = await this.state.storage.list<StoredFrame>({ prefix: FRAME_KEY_PREFIX });
    return [...map.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Drop frames past the count or age limit so storage cannot grow forever. */
  private async prune(): Promise<void> {
    const frames = await this.listFrames();
    const cutoff = Date.now() - EVENT_LOG_TTL_MS;
    const doomed: string[] = [];
    const overflow = Math.max(0, frames.length - EVENT_LOG_MAX_FRAMES);
    frames.forEach((frame, index) => {
      if (index < overflow || frame.ts < cutoff) doomed.push(frameKey(frame.seq));
    });
    if (doomed.length > 0) await this.state.storage.delete(doomed);
  }
}
