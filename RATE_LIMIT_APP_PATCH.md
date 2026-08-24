# Rate limiting: patches for files outside this change's ownership

The identity-based rate limiter (see `src/middleware/rateLimit.ts`,
`src/durableObjects/rateLimiterHub.ts`) is complete and type-checks, but two
files outside the ownership boundary of this change need edits. They are not
applied here; the exact diffs are below.

---

## 1. `src/index.ts` — REQUIRED BEFORE DEPLOY

A Durable Object class must be exported from the Worker entrypoint or the
`RATE_LIMITER_HUB` binding cannot resolve. Without this, `wrangler deploy`
fails with `Uncaught Error: Class "RateLimiterHub" not found` and every
limited route silently falls into the "binding absent → no-op" path.

This is a mechanical consequence of the `durable_objects.bindings` entry added
to `wrangler.jsonc` (which this change does own), and it mirrors exactly how
`OrderEventsHub` is already wired.

```diff
--- a/src/index.ts
+++ b/src/index.ts
@@
 import { createApp } from "./app.js";
 import { OrderEventsHub } from "./durableObjects/orderEventsHub.js";
+import { RateLimiterHub } from "./durableObjects/rateLimiterHub.js";
 
 const app = createApp();
 
 export default {
   fetch: app.fetch,
 };
 
 // Durable Object class, bound in wrangler.jsonc as ORDER_EVENTS_HUB.
 export { OrderEventsHub };
+
+// Durable Object class, bound in wrangler.jsonc as RATE_LIMITER_HUB.
+export { RateLimiterHub };
```

---

## 2. `src/app.ts` — RECOMMENDED (comment/behaviour clarity, not required to build)

The global limiter's call site is unchanged and still compiles: `rateLimit()`
now defaults to keying on the JWT subject instead of the client IP, so no
argument change is needed. But the comment above it is now wrong, and the
behaviour change it hides is significant enough to be stated at the call site.

**What changed underneath it:** with the IP fallback removed, an anonymous
request (no `Authorization` header, no `?token=`) has no identity to key on,
so the global limiter skips it entirely. Authenticated traffic is still capped
at 100/min per user id. This is deliberate — the alternative was an IP key,
which on campus WiFi means one bucket shared by ~600 students, and which any
student escapes by switching to mobile data. Anonymous volumetric abuse is an
edge concern and belongs in Cloudflare's WAF / rate-limiting rules (which
operate on network signals at the edge, outside application code), not here.

The routes that remain reachable anonymously are `/health`, the public menu
reads, and `POST /auth/login`. Login is the one that matters, and it is
covered by its own campus-ID-keyed progressive-delay limiter in
`src/routes/auth.ts`.

```diff
--- a/src/app.ts
+++ b/src/app.ts
@@
-  // Global rate limit: 100 requests per minute per IP
+  // Global rate limit: 100 requests per minute per authenticated user (the
+  // JWT subject). Never keyed on IP — campus WiFi NATs the whole student body
+  // behind one address. Anonymous requests have no identity to key on and are
+  // skipped here; volumetric protection for those belongs in the Cloudflare
+  // WAF. Login has its own campus-ID-keyed limiter in routes/auth.ts.
   app.use(
     "*",
     rateLimit({
       prefix: "global",
       windowSeconds: 60,
       max: 100,
+      strategy: "reject",
       code: "TOO_MANY_REQUESTS",
       message: "Too many requests, please try again later.",
     })
   );
```

`strategy: "reject"` is the default, so adding it is documentation rather than
a behaviour change — it makes the contrast with login's `"progressive-delay"`
visible at the call site.
