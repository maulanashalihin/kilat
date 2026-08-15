/**
 * Auth: PBKDF2 password hashing (Web Crypto), DB-backed sessions,
 * httpOnly cookie helpers, flash messages, password-reset tokens,
 * Google OAuth state, and route guards (requireAuth / guestOnly / requireRole).
 *
 * Guards are Hono middleware: they return a Response to short-circuit the
 * chain, or `next()` to continue.
 *
 * PBKDF2 replaces Bun.password (argon2id) — Workers doesn't ship argon2.
 * Hash format: `pbkdf2:iterations:saltHex:hashHex` (self-describing, upgradable).
 */
import type { Context, Next } from "hono";
import { generateCookie } from "hono/cookie";
import type { FlashData, Role, User } from "../shared/types";
import {
  deleteOtherSessions,
  deletePasswordResetsByEmail,
  deleteSession,
  findPasswordReset,
  findSession,
  findUserById,
  insertPasswordReset,
  insertSession,
  updateSessionFlash,
  deleteEmailVerification,
  deleteUserEmailVerifications,
  findEmailVerification,
  insertEmailVerification,
  verifyUserEmail,
  toPublicUser,
  type UserRow,
} from "./db";
import { config } from "./config";
import type { AppEnv } from "./inertia-middleware";

// ---------------------------------------------------------------------------
// KV session cache (optional — set SESSION_CACHE_ENABLED=true + SESSION_KV binding)
// ---------------------------------------------------------------------------

/** Module-level KV namespace for session caching. Set per-request by
 *  `initSessionCache(env.SESSION_KV)` in the fetch handler. Null when the
 *  binding is absent (tests, local dev without the namespace) or when
 *  `config.sessionCache.enabled` is false. */
let sessionKv: KVNamespace | null = null;

/** Set the KV binding for the current request. Called in the fetch handler
 *  alongside `initConfig` / `initDb`. Pass `undefined` when no binding exists. */
export function initSessionCache(kv: KVNamespace | undefined): void {
  sessionKv = kv ?? null;
}

export const SESSION_COOKIE = "session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Web Crypto helpers (replace node:crypto)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** Hex-encode a byte array. */
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** Hex-decode a string into a byte array. */
const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    out[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  return out;
};

/** Generate `n` random bytes as a hex string. */
const randomHex = (n: number): string => toHex(crypto.getRandomValues(new Uint8Array(n)));

/** SHA-256 hash a string, return hex. */
export const hashToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return toHex(new Uint8Array(digest));
};

/** Constant-time comparison — prevents timing attacks on hash verification. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Passwords (PBKDF2 — OWASP-recommended for Workers)
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 100_000; // Workers caps PBKDF2 at 100K iterations

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toHex(salt)}:${toHex(new Uint8Array(derived))}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split(":");
  if (parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2]!);
  const expected = fromHex(parts[3]!);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return timingSafeEqual(new Uint8Array(derived), expected);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionInfo {
  token: string;
  expiresAt: Date;
}

/** Result of resolving a session token: the public user + one-shot flash.
 *  Used by the Inertia middleware to populate `c.var.user` and `c.var.flash`
 *  in a single call (replaces the separate `resolveUser` + `readFlash` pair). */
export interface ResolvedSession {
  user: User;
  flash: FlashData;
}

/** 256-bit random token; it is never logged and only lives in the cookie.
 *  The DB stores only its SHA-256 hash so a DB leak cannot expose valid tokens. */
export async function createSession(userId: number): Promise<SessionInfo> {
  const token = randomHex(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await insertSession(await hashToken(token), userId, expiresAt.toISOString());
  return { token, expiresAt };
}

export async function resolveUser(
  token: string | null | undefined,
): Promise<UserRow | null> {
  if (!token) return null;
  const hashed = await hashToken(token);
  const session = await findSession(hashed);
  if (!session) return null;
  if (Date.now() > new Date(session.expiresAt).getTime()) {
    await deleteSession(hashed); // lazy cleanup of expired sessions
    return null;
  }
  return (await findUserById(session.userId)) ?? null;
}

// --- KV cache helpers (internal) -------------------------------------------

interface CachedSession {
  user: User;
  flash: FlashData;
  expiresAt: string;
}

const cacheKey = (hashedToken: string) => `session:${hashedToken}`;

/** Read a cached session from KV. Returns null on miss, disabled, or error. */
async function getCachedSession(
  hashedToken: string,
): Promise<CachedSession | null> {
  if (!sessionKv || !config.sessionCache.enabled) return null;
  try {
    const raw = await sessionKv.get(cacheKey(hashedToken));
    if (!raw) return null;
    return JSON.parse(raw) as CachedSession;
  } catch {
    return null;
  }
}

/** Write a session entry to KV with the configured TTL. Best-effort. */
async function setCachedSession(
  hashedToken: string,
  data: CachedSession,
): Promise<void> {
  if (!sessionKv || !config.sessionCache.enabled) return;
  try {
    await sessionKv.put(cacheKey(hashedToken), JSON.stringify(data), {
      expirationTtl: config.sessionCache.ttlSeconds,
    });
  } catch {
    // Cache write failure is non-fatal — next request falls back to D1.
  }
}

/** Delete a cached session from KV. Best-effort. */
async function deleteCachedSession(hashedToken: string): Promise<void> {
  if (!sessionKv || !config.sessionCache.enabled) return;
  try {
    await sessionKv.delete(cacheKey(hashedToken));
  } catch {
    // Ignore — stale entry expires via TTL.
  }
}

// --- Combined session resolve (user + flash, KV-cached) --------------------

/** Resolve a session token to the public user + flash data.
 *
 *  Combines `resolveUser` + `readFlash` into a single D1 `findSession` +
 *  `findUserById` pair (was 3 queries: findSession + findUserById + findSession
 *  again for flash). When KV session caching is enabled (`SESSION_CACHE_ENABLED`
 *  + `SESSION_KV` binding), a cache hit returns both user and flash with **zero
 *  D1 queries**.
 *
 *  Security: D1 remains the source of truth. KV is a cache — on logout the KV
 *  entry is deleted alongside the D1 row. `deleteOtherSessionsByToken` cannot
 *  enumerate other sessions' KV keys, so revoked sessions on other devices may
 *  remain cache-valid for up to `SESSION_CACHE_TTL_SECONDS` (default 300s).
 *  Reduce the TTL or disable the cache if that window is unacceptable. */
export async function resolveSession(
  token: string | null | undefined,
): Promise<ResolvedSession | null> {
  if (!token) return null;
  const hashed = await hashToken(token);

  // 1. Try KV cache (0 D1 queries on hit).
  const cached = await getCachedSession(hashed);
  if (cached) {
    if (Date.now() > new Date(cached.expiresAt).getTime()) {
      await deleteCachedSession(hashed);
      return null;
    }
    return { user: cached.user, flash: cached.flash };
  }

  // 2. Cache miss — full D1 lookup (findSession + findUserById).
  const session = await findSession(hashed);
  if (!session) return null;
  if (Date.now() > new Date(session.expiresAt).getTime()) {
    await deleteSession(hashed); // lazy cleanup of expired sessions
    return null;
  }
  const userRow = await findUserById(session.userId);
  if (!userRow) return null;

  let flash: FlashData = {};
  try {
    flash = (JSON.parse(session.flash) as FlashData) ?? {};
  } catch {
    flash = {};
  }

  const user = toPublicUser(userRow);
  await setCachedSession(hashed, {
    user,
    flash,
    expiresAt: session.expiresAt,
  });

  return { user, flash };
}

/** Delete a session by its raw (cookie) token — hashes before hitting the DB. */
export async function deleteSessionByToken(token: string): Promise<void> {
  const hashed = await hashToken(token);
  await deleteSession(hashed);
  await deleteCachedSession(hashed);
}
/** Delete every session for `userId` except the one owning `token` (password
 *  changes invalidate other devices; the current session stays signed in).
 *
 *  KV cache limitation: other sessions' KV entries cannot be enumerated and
 *  will expire naturally within `SESSION_CACHE_TTL_SECONDS` (default 300s).
 *  Reduce the TTL if this revocation window is unacceptable. */
export async function deleteOtherSessionsByToken(
  token: string,
  userId: number,
): Promise<void> {
  await deleteOtherSessions(userId, await hashToken(token));
}

// ---------------------------------------------------------------------------
// Flash messages (one-shot, stored on the session row; consumed on render)
// ---------------------------------------------------------------------------

export async function readFlash(
  token: string | null | undefined,
): Promise<FlashData> {
  if (!token) return {};
  const session = await findSession(await hashToken(token));
  if (!session) return {};
  try {
    const parsed = JSON.parse(session.flash) as FlashData;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export async function setFlash(
  token: string,
  flash: FlashData,
): Promise<void> {
  const hashed = await hashToken(token);
  await updateSessionFlash(JSON.stringify(flash), hashed);
  // Invalidate KV cache — flash is one-shot, the cached copy is now stale.
  await deleteCachedSession(hashed);
}

export async function clearFlash(
  token: string | null | undefined,
): Promise<void> {
  if (!token) return;
  const hashed = await hashToken(token);
  await updateSessionFlash("{}", hashed);
  // Invalidate KV cache — flash was consumed, cached copy is stale.
  await deleteCachedSession(hashed);
}

// ---------------------------------------------------------------------------
// Password reset tokens (hashed at rest; the raw token goes in the email)
// ---------------------------------------------------------------------------

/** Create a reset token for `email` and return the raw token to email out. */
export async function createPasswordReset(email: string): Promise<string> {
  const token = randomHex(32);
  await insertPasswordReset(
    email,
    await hashToken(token),
    new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(),
  );
  return token;
}

/** Verify a raw reset token for `email` (consumes nothing; caller deletes). */
export async function verifyPasswordReset(
  email: string,
  token: string,
): Promise<boolean> {
  const row = await findPasswordReset(await hashToken(token));
  if (!row || row.email.toLowerCase() !== email.toLowerCase()) return false;
  return Date.now() <= new Date(row.expiresAt).getTime();
}

export async function clearPasswordResets(email: string): Promise<void> {
  await deletePasswordResetsByEmail(email);
}

// ---------------------------------------------------------------------------
// Email verification tokens (hashed at rest; the raw token goes in the email)
// ---------------------------------------------------------------------------

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Create a verification token for `userId` and return the raw token to email out. */
export async function createEmailVerification(userId: number): Promise<string> {
  const token = randomHex(32);
  await deleteUserEmailVerifications(userId);
  await insertEmailVerification(
    await hashToken(token),
    userId,
    new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS).toISOString(),
  );
  return token;
}

/** Verify a raw email verification token. Returns the user id on success
 *  (and consumes the token + marks the user verified), or null on failure. */
export async function verifyEmailToken(token: string): Promise<number | null> {
  const hashed = await hashToken(token);
  const row = await findEmailVerification(hashed);
  if (!row) return null;
  if (Date.now() > new Date(row.expiresAt).getTime()) {
    await deleteEmailVerification(hashed);
    return null;
  }
  await verifyUserEmail(row.userId);
  await deleteUserEmailVerifications(row.userId);
  return row.userId;
}

// ---------------------------------------------------------------------------
// Cookies (hono/cookie helpers — set on the Hono context)
//
// Note: the Inertia adapter returns plain `Response` objects, and Hono drops
// headers queued via `c.header()`/`setCookie()` when a handler returns a
// custom Response. Appending the serialized cookie to `c.res.headers`
// instead works because the `context.res` setter merges `c.res` headers
// (including Set-Cookie) into the handler-returned response.
// ---------------------------------------------------------------------------

export function setSessionCookie(
  c: Context<AppEnv>,
  token: string,
  expiresAt: Date,
): void {
  c.res.headers.append(
    "set-cookie",
    generateCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax", // blocks cross-site POSTs (CSRF baseline, see security.ts)
      secure: config.isProd,
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
      expires: expiresAt,
    }),
  );
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  c.res.headers.append(
    "set-cookie",
    generateCookie(SESSION_COOKIE, "", {
      httpOnly: true,
      sameSite: "Lax",
      secure: config.isProd,
      path: "/",
      maxAge: 0,
    }),
  );
}

export const OAUTH_STATE_COOKIE = "oauth_state";

/** Short-lived state cookie protecting the OAuth callback from CSRF. */
export function setOAuthStateCookie(c: Context<AppEnv>, state: string): void {
  c.res.headers.append(
    "set-cookie",
    generateCookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "Lax",
      secure: config.isProd,
      path: "/",
      maxAge: 600, // 10 minutes
    }),
  );
}

export function clearOAuthStateCookie(c: Context<AppEnv>): void {
  c.res.headers.append(
    "set-cookie",
    generateCookie(OAUTH_STATE_COOKIE, "", {
      httpOnly: true,
      sameSite: "Lax",
      secure: config.isProd,
      path: "/",
      maxAge: 0,
    }),
  );
}

// ---------------------------------------------------------------------------
// Route guards (Hono middleware: Response short-circuits, next() continues)
// ---------------------------------------------------------------------------

const redirectTo = (request: Request, path: string) => {
  const url = safeUrl(request.url);
  // No scheme correction needed — on Workers, request.url already has the
  // correct scheme (https://) because the Worker runs after TLS termination.
  return new Response(null, { status: 302, headers: { location: new URL(path, url.toString()).toString() } });
};

import { safeUrl } from "./url";

export const requireAuth = async (c: Context<AppEnv>, next: Next) => {
  if (!c.var.user) return redirectTo(c.req.raw, "/login");
  return next();
};

export const guestOnly = async (c: Context<AppEnv>, next: Next) => {
  if (c.var.user) return redirectTo(c.req.raw, "/dashboard");
  return next();
};

/** Guard factory: e.g. `requireRole('admin')` — non-admins go to /dashboard. */
export const requireRole =
  (...roles: Role[]) =>
  async (c: Context<AppEnv>, next: Next) => {
    if (!c.var.user) return redirectTo(c.req.raw, "/login");
    if (!roles.includes(c.var.user.role))
      return redirectTo(c.req.raw, "/dashboard");
    return next();
  };
