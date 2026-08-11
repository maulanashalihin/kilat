/**
 * KV-backed fixed-window rate limiter (Cloudflare Workers).
 *
 * Replaces the in-memory Map limiter from the Bun version — Workers
 * isolates are stateless, so per-isolate memory cannot enforce cross-
 * request limits. Each request reads the counter for its window from KV,
 * increments it, and writes it back with a TTL.
 *
 * Trade-offs (documented, deliberate for a starter):
 *  - KV get→put is not atomic: under very high concurrency the counter
 *    can under-count (eventual consistency, ~seconds). Cloudflare's own
 *    guidance accepts this for rate limiting; for strict atomicity use a
 *    Durable Object instead.
 *  - Fails OPEN when no KV binding is present (unit tests, or a deployment
 *    whose wrangler.toml lacks the binding). The shipped wrangler.toml
 *    includes the binding, so default deploys are protected.
 */
import type { Context, Next } from "hono";
import type { AppEnv } from "./inertia-middleware";

export interface RateLimitOptions {
  max: number;
  windowSeconds: number;
  /** Key namespace — separate counters per scope (auth vs global). */
  scope: string;
  /**
   * When set, only paths in this list are counted/enforced. Required for
   * limiters mounted on Hono sub-apps: `app.route("/", subApp)` runs the
   * sub-app's `app.use()` middleware for EVERY path under the mount point,
   * so without a path filter an "auth" limiter would also throttle
   * unrelated pages (/, /dashboard, …).
   */
  paths?: string[];
}

/** Client IP from Cloudflare's connecting-IP header (fallback chain). */
function clientIp(c: Context<AppEnv>): string {
  const cf = c.req.raw.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const fwd = c.req.raw.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]!.trim();
    if (first) return first;
  }
  return "unknown";
}

export function rateLimit(opts: RateLimitOptions) {
  return async (c: Context<AppEnv>, next: Next) => {
    // Disabled (max <= 0) or no KV binding → pass through.
    if (opts.max <= 0 || opts.windowSeconds <= 0) return next();
    // Path filter — only enforce for the configured paths (see RateLimitOptions).
    if (opts.paths) {
      const pathname = new URL(c.req.url).pathname;
      if (!opts.paths.includes(pathname)) return next();
    }
    const kv = c.env?.RATE_LIMIT_KV;
    if (!kv) return next();

    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / opts.windowSeconds) * opts.windowSeconds;
    const key = `ratelimit:${opts.scope}:${clientIp(c)}`;

    let count = 0;
    try {
      const raw = await kv.get(key);
      if (raw) {
        const data = JSON.parse(raw) as { window: number; count: number };
        if (data.window === windowStart) count = data.count;
      }
    } catch {
      // Corrupt or malformed entry — treat as a fresh window.
    }

    if (count >= opts.max) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": String(opts.windowSeconds) },
      });
    }

    // Best-effort increment (KV eventual consistency — see header comment).
    await kv.put(
      key,
      JSON.stringify({ window: windowStart, count: count + 1 }),
      { expirationTtl: opts.windowSeconds * 2 },
    );
    return next();
  };
}
