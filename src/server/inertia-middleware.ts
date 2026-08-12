/**
 * Inertia middleware: resolves the session per request and exposes the
 * Inertia adapter as a typed context variable (Hono `Variables`).
 *
 * Registered once on the app instance. Hono middleware attached with
 * `app.use()` runs for every request — including unmatched routes — so the
 * not-found/error handlers can rely on `c.var.inertia` being populated.
 *
 * All session/DB calls are async (D1).
 *
 * A per-request CSP nonce is generated here and passed to the Inertia
 * adapter so inline scripts/styles can be nonce-tagged, allowing a
 * strict CSP without 'unsafe-inline'.
 */
import type { Next } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { FlashData, User } from "../shared/types";
import { readFlash, resolveUser, SESSION_COOKIE } from "./auth";
import { toPublicUser } from "./db";
import { Inertia, type InertiaAssets } from "./inertia";

/** Context variables shared by every route/middleware. */
export interface AppEnv {
  Bindings: {
    /** KV namespace for the rate limiter (see wrangler.toml). Optional at
     *  the type level so tests/local runs without the binding fail open. */
    RATE_LIMIT_KV?: KVNamespace;
    /** R2 bucket for avatar storage (see wrangler.toml). Optional at the
     *  type level so tests/local runs without the binding skip R2 features. */
    AVATARS?: R2Bucket;
  };
  Variables: {
    user: User | null;
    flash: FlashData;
    sessionToken: string | null;
    inertia: Inertia;
    requestId: string;
    /** Per-request CSP nonce (base64, 22 chars). */
    cspNonce: string;
  };
}

/** Generate a base64 nonce from 16 random bytes (Web Crypto — Workers-safe). */
function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export const inertiaMiddleware =
  (assets: InertiaAssets) => async (c: Context<AppEnv>, next: Next) => {
    const raw = getCookie(c, SESSION_COOKIE);
    const sessionToken = typeof raw === "string" && raw.length > 0 ? raw : null;
    const row = await resolveUser(sessionToken);
    const user = row ? toPublicUser(row) : null;
    const flash = await readFlash(sessionToken);
    const cspNonce = generateNonce();
    c.set("user", user);
    c.set("flash", flash);
    c.set("sessionToken", sessionToken);
    c.set("cspNonce", cspNonce);
    c.set(
      "inertia",
      new Inertia(
        {
          request: c.req.raw,
          headers: Object.fromEntries(c.req.raw.headers.entries()),
          user,
          flash,
          sessionToken,
          cspNonce,
        },
        assets,
      ),
    );
    await next();
  };

