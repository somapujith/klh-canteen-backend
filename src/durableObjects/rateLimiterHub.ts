/**
 * Durable Object backing every rate-limit counter in the app.
 *
 * Replaces the old KV-backed counter in src/middleware/rateLimit.ts, which did
 * a `get` followed by a `put`. That read-modify-write is not atomic on KV (and
 * KV reads are eventually consistent), so under a burst of ~100 concurrent
 * requests every caller read the same stale value, every caller saw
 * `current < max`, and every caller was let through — the limiter effectively
 * did nothing exactly when it mattered.
 *
 * A Durable Object is a single-threaded durable process, and its storage input
 * gates guarantee that no other event is delivered to the object while a
 * storage operation is in flight. That makes the get -> increment -> put
 * sequence below genuinely atomic: N concurrent callers observe N distinct
 * counts, never the same one.
 *
 * Instances are sharded per (prefix, identity) by the caller — see
 * `counterStub()` in src/middleware/rateLimit.ts — so there is no single global
 * DO serialising all traffic; each user (or each campus ID at login) gets its
 * own object.
 *
 * Routing (all internal, reached only via env.RATE_LIMITER_HUB from the
 * Worker — see src/middleware/rateLimit.ts):
 *   POST /consume  { bucket, windowSeconds } -> { count, resetAt }
 *       Atomically increments the fixed-window counter and returns the
 *       POST-increment attempt count for the current window.
 *   POST /reset    { bucket }                -> 204
 *       Clears a counter (used after a successful login so a legitimate user
 *       who fumbled their password a few times starts clean again).
 */

interface CounterState {
  /** Attempts recorded in the current window. */
  count: number;
  /** Epoch ms at which the current window rolls over. */
  resetAt: number;
}

/** Namespace for counter keys in DO storage, so sweeps never touch anything else. */
const KEY_PREFIX = "c:";

/** Slack added when scheduling the cleanup alarm, so it fires after expiry. */
const SWEEP_GRACE_MS = 5_000;

export class RateLimiterHub {
  private readonly state: DurableObjectState;

  // Signature required by the Durable Objects runtime; env is unused because
  // the hub only ever touches its own storage.
  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/consume") {
      return this.handleConsume(request);
    }
    if (request.method === "POST" && url.pathname === "/reset") {
      return this.handleReset(request);
    }
    return new Response("Not found", { status: 404 });
  }

  private async handleConsume(request: Request): Promise<Response> {
    const body = await request.json<{ bucket?: string; windowSeconds?: number }>();
    const bucket = body.bucket;
    const windowSeconds = body.windowSeconds;
    if (!bucket || !windowSeconds || windowSeconds <= 0) {
      return new Response("Missing bucket or windowSeconds", { status: 400 });
    }

    const key = KEY_PREFIX + bucket;
    const now = Date.now();

    // Atomic section: the input gate holds back any other event delivery to
    // this object between this get and the put below, so no two concurrent
    // callers can observe the same count.
    const existing = await this.state.storage.get<CounterState>(key);
    const isNewWindow = !existing || existing.resetAt <= now;
    const current = isNewWindow
      ? { count: 0, resetAt: now + windowSeconds * 1000 }
      : existing;

    const updated: CounterState = { count: current.count + 1, resetAt: current.resetAt };
    await this.state.storage.put(key, updated);

    // DO storage has no TTL, so expired buckets are swept by an alarm instead.
    // Only checked when a window opens — an alarm already pending for an older
    // window re-arms itself from whatever is still live when it fires.
    if (isNewWindow) await this.ensureSweepScheduled(updated.resetAt);

    return Response.json({ count: updated.count, resetAt: updated.resetAt });
  }

  private async handleReset(request: Request): Promise<Response> {
    const body = await request.json<{ bucket?: string }>();
    if (!body.bucket) return new Response("Missing bucket", { status: 400 });
    await this.state.storage.delete(KEY_PREFIX + body.bucket);
    return new Response(null, { status: 204 });
  }

  /** Schedules the cleanup alarm if one isn't already pending. */
  private async ensureSweepScheduled(resetAt: number): Promise<void> {
    const pending = await this.state.storage.getAlarm();
    if (pending === null) {
      await this.state.storage.setAlarm(resetAt + SWEEP_GRACE_MS);
    }
  }

  /** Deletes expired counters and re-arms itself while any live ones remain. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.state.storage.list<CounterState>({ prefix: KEY_PREFIX });

    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const [key, value] of entries) {
      if (value.resetAt <= now) {
        await this.state.storage.delete(key);
      } else if (value.resetAt < nextExpiry) {
        nextExpiry = value.resetAt;
      }
    }

    if (nextExpiry !== Number.POSITIVE_INFINITY) {
      await this.state.storage.setAlarm(nextExpiry + SWEEP_GRACE_MS);
    }
  }
}
