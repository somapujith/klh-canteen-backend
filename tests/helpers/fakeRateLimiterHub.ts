/**
 * An in-process stand-in for the RateLimiterHub Durable Object.
 *
 * WHY THIS EXISTS. The limiter no-ops entirely when `RATE_LIMITER_HUB` is
 * unbound, which is the case under plain Node — so without a stand-in, every
 * "the limiter must not lock anyone out" test would pass by doing nothing at
 * all, which is the definition of a fake test.
 *
 * WHAT IT IS NOT. It is not a mock of the code under test. The middleware
 * (src/middleware/rateLimit.ts) runs for real; this only replaces its
 * collaborator, and it implements the collaborator's actual wire contract —
 * `POST /consume {bucket, windowSeconds} -> {count, resetAt}` and
 * `POST /reset {bucket} -> 204`, fixed window, count returned POST-increment —
 * copied from src/durableObjects/rateLimiterHub.ts.
 *
 * WHAT IT CANNOT PROVE. Real Durable Object atomicity (input gates) and the
 * real `env(c)` binding resolution on workerd. Those need vitest-pool-workers;
 * see TESTING.md.
 */

interface CounterState {
  count: number;
  resetAt: number;
}

export class FakeRateLimiterHub {
  /** objectName ("<prefix>:<identity>") -> bucket -> counter. */
  private readonly objects = new Map<string, Map<string, CounterState>>();

  /** Every object name the middleware has addressed, in order. */
  readonly addressed: string[] = [];

  get namespace(): any {
    return {
      idFromName: (name: string) => name,
      get: (name: string) => ({ fetch: (url: string, init: any) => this.handle(name, url, init) }),
    };
  }

  counterFor(objectName: string, bucket: string): CounterState | undefined {
    return this.objects.get(objectName)?.get(bucket);
  }

  private async handle(objectName: string, url: string, init: any): Promise<Response> {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    this.addressed.push(objectName);

    const buckets = this.objects.get(objectName) ?? new Map<string, CounterState>();
    this.objects.set(objectName, buckets);

    if (path === "/consume") {
      const now = Date.now();
      const existing = buckets.get(body.bucket);
      const current =
        !existing || existing.resetAt <= now
          ? { count: 0, resetAt: now + body.windowSeconds * 1000 }
          : existing;
      const updated: CounterState = { count: current.count + 1, resetAt: current.resetAt };
      buckets.set(body.bucket, updated);
      return Response.json(updated);
    }

    if (path === "/reset") {
      buckets.delete(body.bucket);
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  }
}
