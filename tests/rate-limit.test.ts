/**
 * Rate limiter unit tests — deterministic verification of the KV fixed-window
 * logic with an in-memory KV mock (no Wrangler/Miniflare needed).
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { rateLimit, type RateLimitOptions } from "../src/server/rate-limit";

/** Minimal KVNamespace-shaped mock (get/put with an in-memory Map). */
function createKvMock() {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      // Simulate TTL expiry.
      if (Date.now() / 1000 > entry.ttl) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(
      key: string,
      value: string,
      opts?: { expirationTtl?: number },
    ): Promise<void> {
      store.set(key, {
        value,
        ttl: Date.now() / 1000 + (opts?.expirationTtl ?? 60),
      });
    },
  };
}

function buildApp(opts: RateLimitOptions, kv: ReturnType<typeof createKvMock>) {
  const app = new Hono<{ Bindings: { RATE_LIMIT_KV?: unknown } }>();
  app.use(rateLimit(opts) as never);
  app.get("/", (c) => c.text("ok"));
  app.get("/dashboard", (c) => c.text("ok"));
  app.get("/login", (c) => c.text("ok"));
  app.get("/register", (c) => c.text("ok"));
  // Hono's app.request(input, init, env) — env must be passed explicitly.
  return (url: string, init?: RequestInit) =>
    app.request(url, init, { RATE_LIMIT_KV: kv } as never);
}

describe("rate limit (KV fixed window)", () => {
  it("allows requests up to max, then blocks with 429", async () => {
    const kv = createKvMock();
    const app = buildApp({ max: 5, windowSeconds: 60, scope: "test" }, kv);
    const req = (i: number) =>
      app("http://localhost/", {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      });

    for (let i = 0; i < 5; i++) {
      expect((await req(i)).status).toBe(200);
    }
    for (let i = 5; i < 8; i++) {
      const res = await req(i);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
    }
    // Counter stored under the scoped, per-IP key.
    expect(kv.store.has("ratelimit:test:1.2.3.4")).toBe(true);
  });

  it("resets the counter when the window rolls over", async () => {
    const kv = createKvMock();
    const app = buildApp({ max: 2, windowSeconds: 60, scope: "test" }, kv);

    // Saturate the current window: 2 allowed, 3rd blocked.
    expect((await app("http://localhost/", { headers: { "cf-connecting-ip": "9.9.9.9" } })).status).toBe(200);
    expect((await app("http://localhost/", { headers: { "cf-connecting-ip": "9.9.9.9" } })).status).toBe(200);
    expect((await app("http://localhost/", { headers: { "cf-connecting-ip": "9.9.9.9" } })).status).toBe(429);

    // Force the stored entry into a past window → next request is allowed.
    const key = "ratelimit:test:9.9.9.9";
    const raw = JSON.parse(kv.store.get(key)!.value) as { window: number; count: number };
    kv.store.set(key, { value: JSON.stringify({ window: raw.window - 60, count: 99 }), ttl: Date.now() / 1000 + 60 });
    expect((await app("http://localhost/", { headers: { "cf-connecting-ip": "9.9.9.9" } })).status).toBe(200);
  });

  it("separates counters per scope and per IP", async () => {
    const kv = createKvMock();
    const appA = buildApp({ max: 1, windowSeconds: 60, scope: "auth" }, kv);
    const appG = buildApp({ max: 1, windowSeconds: 60, scope: "global" }, kv);

    await appA("http://localhost/", { headers: { "cf-connecting-ip": "1.1.1.1" } });
    // Different scope, same IP → still allowed.
    expect((await appG("http://localhost/", { headers: { "cf-connecting-ip": "1.1.1.1" } })).status).toBe(200);
    // Same scope, different IP → still allowed.
    expect((await appA("http://localhost/", { headers: { "cf-connecting-ip": "2.2.2.2" } })).status).toBe(200);
    // Same scope, same IP → blocked.
    expect((await appA("http://localhost/", { headers: { "cf-connecting-ip": "1.1.1.1" } })).status).toBe(429);
  });

  it("fails open without a KV binding", async () => {
    const app = new Hono();
    app.use(rateLimit({ max: 1, windowSeconds: 60, scope: "test" } as never));
    app.get("/", (c) => c.text("ok"));
    expect((await app.request("http://localhost/")).status).toBe(200);
    expect((await app.request("http://localhost/")).status).toBe(200);
  });

  it("fails open when disabled (max <= 0)", async () => {
    const kv = createKvMock();
    const app = buildApp({ max: 0, windowSeconds: 60, scope: "test" }, kv);
    expect((await app("http://localhost/")).status).toBe(200);
    expect((await app("http://localhost/")).status).toBe(200);
  });

  it("only enforces configured paths (sub-app middleware semantics)", async () => {
    const kv = createKvMock();
    const app = buildApp(
      { max: 2, windowSeconds: 60, scope: "auth", paths: ["/login", "/register"] },
      kv,
    );

    // Non-listed paths are never counted.
    for (let i = 0; i < 10; i++) {
      expect((await app("http://localhost/", { headers: { "cf-connecting-ip": "5.5.5.5" } })).status).toBe(200);
      expect((await app("http://localhost/dashboard", { headers: { "cf-connecting-ip": "5.5.5.5" } })).status).toBe(200);
    }
    // Listed path enforces its own counter.
    expect((await app("http://localhost/login", { headers: { "cf-connecting-ip": "5.5.5.5" } })).status).toBe(200);
    expect((await app("http://localhost/login", { headers: { "cf-connecting-ip": "5.5.5.5" } })).status).toBe(200);
    expect((await app("http://localhost/login", { headers: { "cf-connecting-ip": "5.5.5.5" } })).status).toBe(429);
    // Different listed path, same counter bucket (scope+IP) → also blocked.
    expect((await app("http://localhost/register", { headers: { "cf-connecting-ip": "5.5.5.5" } })).status).toBe(429);
  });
});
