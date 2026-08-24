import { createApp } from "./app.js";
import { OrderEventsHub } from "./durableObjects/orderEventsHub.js";
import { RateLimiterHub } from "./durableObjects/rateLimiterHub.js";

const app = createApp();

export default {
  fetch: app.fetch,
};

// Durable Object classes, bound in wrangler.jsonc as ORDER_EVENTS_HUB and
// RATE_LIMITER_HUB. A DO class must be exported from the entrypoint or its
// binding cannot resolve at runtime.
export { OrderEventsHub, RateLimiterHub };
