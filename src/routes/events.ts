import { Hono } from "hono";
import type { Context } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { connectToHub } from "../services/sseService.js";
import { guestSubjectId, verifyGuestSession } from "../services/guestSessionService.js";
import { getBindings } from "../lib/context.js";
import { ApiError } from "../middleware/errorHandler.js";
import { BROADCAST_COALESCE_MS, EVENT_LOG_TTL_MS, REALTIME_PROTOCOL_VERSION } from "../lib/realtime.js";
import type { AppEnv } from "../types.js";
import type { ConnectOptions } from "../services/sseService.js";

export const eventsRouter = new Hono<AppEnv>();

/** Header the walk-up guest flow already uses on every /guest/* call. */
const GUEST_SESSION_HEADER = "X-Guest-Session";
/**
 * Query parameter carrying the same token.
 *
 * `EventSource` cannot set request headers — that is a hard limit of the
 * browser API, not a shortcut — so the only way a guest page can open this
 * stream is to put its credential in the URL. That is the same trade the JWT
 * clients already make with `?token=`, and it is why this parameter is named
 * differently: a JWT and a guest session are verified with different secrets
 * and grant different things, and conflating them in one parameter would mean
 * one of the two verifiers deciding what the other's credential was.
 */
const GUEST_TOKEN_QUERY = "guestToken";

/**
 * Builds the hub subscription for the authenticated caller.
 *
 * Only kitchen staff watch a kitchen board, so only they subscribe to
 * KITCHEN-scoped frames — this is what keeps order-board traffic off every
 * student's connection. A SUPERADMIN has no single kitchen, so they watch
 * both, or one if they ask for it with `?kitchen=`.
 */
function subscriptionFor(role: string, userId: string, kitchen: string | null | undefined, requested: string | undefined): ConnectOptions {
  const wanted = requested === "SNACKS" || requested === "MEALS" ? requested : undefined;

  if (role === "ADMIN") {
    return { subjectId: userId, role, kitchens: [kitchen ?? wanted ?? "SNACKS"] };
  }
  if (role === "SUPERADMIN") {
    return wanted
      ? { subjectId: userId, role, kitchens: [wanted] }
      : { subjectId: userId, role, kitchens: ["SNACKS", "MEALS"], shard: "SNACKS" };
  }
  // Students watch the menu (ALL scope) and their own orders (SUBJECT scope);
  // they are hashed across shards rather than pinned to a kitchen.
  return { subjectId: userId, role, kitchens: [] };
}

/**
 * Subscription for a VERIFIED guest session.
 *
 * `kitchens: []` is the load-bearing part. The hub matches KITCHEN-scoped
 * frames with `sub.kitchens.includes(...)`, so an empty list means the entire
 * kitchen board — every other customer's name, order number and total — can
 * never be delivered on this connection. `?kitchen=` is deliberately not read
 * here: for a guest it would be a caller-supplied request to widen their own
 * audience, which is precisely the thing that must not be possible.
 *
 * What is left is the menu (ALL scope — the same public data the guest already
 * fetches over `GET /menu`) and SUBJECT frames addressed to this one session's
 * namespaced subject id.
 */
function guestSubscription(sessionId: string): ConnectOptions {
  return { subjectId: guestSubjectId(sessionId), role: "GUEST", kitchens: [] };
}

/** The guest token, from the query string or either header form. */
function guestTokenFrom(c: Context<AppEnv>): string {
  const queryToken = c.req.query(GUEST_TOKEN_QUERY);
  if (queryToken) return queryToken;
  const header = c.req.header(GUEST_SESSION_HEADER);
  if (header) return header;
  const authHeader = c.req.header("Authorization");
  return authHeader?.startsWith("Guest ") ? authHeader.slice(6) : "";
}

/**
 * Decides who is connecting and what they may receive, or refuses.
 *
 * Two credentials, checked in a fixed order and never mixed:
 *
 *   1. A guest session token, if one was presented. It is verified against
 *      QR_TOKEN_SECRET by `verifyGuestSession` — a full HMAC comparison with
 *      an expiry check, not a decode — and the session id is read back out of
 *      the verified payload. Anything malformed, expired or forged returns
 *      null and is refused here.
 *   2. Otherwise the existing JWT gate, invoked unchanged. Logged-in students
 *      and admins take exactly the path they took before: same middleware,
 *      same revocation and deactivation checks, same error codes.
 *
 * Presenting a guest token when you also hold a JWT downgrades you to the
 * guest subscription; that is strictly less access, so it is safe.
 */
async function resolveSubscription(c: Context<AppEnv>): Promise<ConnectOptions> {
  const guestToken = guestTokenFrom(c);
  if (guestToken) {
    const { QR_TOKEN_SECRET } = getBindings(c);
    const sessionId = verifyGuestSession(guestToken, QR_TOKEN_SECRET);
    if (!sessionId) {
      throw new ApiError(401, "INVALID_GUEST_SESSION", "Guest session is invalid or has expired");
    }
    return guestSubscription(sessionId);
  }

  // No guest credential: run the standard JWT gate. It throws on any failure
  // and sets c.get("user") on success, so the next line is only reached by a
  // caller it accepted.
  await requireAuth()(c, async () => {});
  const user = c.get("user")!;
  return subscriptionFor(user.role, user.id, user.kitchen, c.req.query("kitchen"));
}

/**
 * Live event stream.
 *
 * Two transports, one endpoint:
 *   - `Upgrade: websocket` -> hibernatable WebSocket. Preferred: the hub can
 *     be evicted from memory while the connection stays open, and heartbeats
 *     are answered without waking it.
 *   - otherwise            -> SSE, for the existing EventSource clients.
 *
 * Two audiences, one endpoint:
 *   - `Authorization: Bearer <jwt>` or `?token=<jwt>`   -> student / admin
 *   - `?guestToken=<t>` or `X-Guest-Session: <t>`       -> walk-up guest
 *
 * Resume: EventSource sends `Last-Event-ID` automatically on reconnect;
 * WebSocket clients cannot set headers, so they pass `?lastEventId=<id>`.
 * Either way the hub replays what was missed, or sends one SYNC_REQUIRED if
 * the cursor has aged out.
 */
eventsRouter.get("/stream", async (c) => {
  const options = await resolveSubscription(c);
  const stream = await connectToHub(c.env, options, c.req.raw);
  if (!stream) {
    throw new ApiError(503, "SSE_UNAVAILABLE", "Real-time events are unavailable in this environment");
  }
  return stream;
});

/** Explicit WebSocket entry point, for clients that would rather not rely on
 *  header-based content negotiation. Same subscription rules as /stream. */
eventsRouter.get("/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    throw new ApiError(426, "UPGRADE_REQUIRED", "This endpoint requires a WebSocket upgrade");
  }
  const options = await resolveSubscription(c);
  const stream = await connectToHub(c.env, options, c.req.raw);
  if (!stream) {
    throw new ApiError(503, "SSE_UNAVAILABLE", "Real-time events are unavailable in this environment");
  }
  return stream;
});

/**
 * Lets a client discover the contract it is talking to before deciding
 * whether to patch state or refetch. Unauthenticated on purpose: it carries
 * no data, only protocol constants.
 */
eventsRouter.get("/meta", (c) =>
  c.json({
    protocolVersion: REALTIME_PROTOCOL_VERSION,
    transports: ["sse", "ws"],
    coalesceWindowMs: BROADCAST_COALESCE_MS,
    resumeWindowMs: EVENT_LOG_TTL_MS,
    resume: { sse: "Last-Event-ID header", ws: "?lastEventId= query parameter" },
    auth: {
      jwt: "Authorization: Bearer <token>, or ?token= for EventSource/WebSocket",
      guest: `${GUEST_SESSION_HEADER} header, or ?${GUEST_TOKEN_QUERY}= for EventSource/WebSocket`,
    },
    eventTypes: ["MENU_UPDATE", "ORDER_BOARD_UPDATE", "ORDER_UPDATE", "HELLO", "SYNC_REQUIRED"],
  }),
);
