import { createApp } from "./app.js";
import { OrderEventsHub } from "./durableObjects/orderEventsHub.js";

const app = createApp();

export default {
  fetch: app.fetch,
};

// Durable Object class, bound in wrangler.jsonc as ORDER_EVENTS_HUB.
export { OrderEventsHub };
