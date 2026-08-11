/**
 * App composition: logging → CSRF origin check → security headers →
 * Inertia middleware → routes → onError/notFound.
 *
 * Workers-specific changes:
 *  - No /uploads routes (upload feature skipped in CF experiment).
 *  - No /assets/* handler (Workers Static Assets binding serves directly).
 *  - /health uses async pingDb (D1).
 *  - Rate limiter is a no-op stub (see rate-limit.ts).
 */
import { getCookie } from "hono/cookie";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { config } from "./config";
import { rateLimit } from "./rate-limit";
import { SESSION_COOKIE } from "./auth";
import { pingDb } from "./db";
import { Inertia, type InertiaAssets } from "./inertia";
import { inertiaMiddleware, type AppEnv } from "./inertia-middleware";
import { logError, requestLogger } from "./logger";
import { authRoutes, VALIDATION_MESSAGES } from "./routes/auth.routes";
import { googleOauthRoutes } from "./routes/google-oauth.routes";
import { pageRoutes } from "./routes/pages.routes";
import {
  profileRoutes,
  PROFILE_VALIDATION_MESSAGES,
} from "./routes/profile.routes";
import { checkOrigin } from "./security";
import { safeUrl } from "./url";
import { ValidationFailed } from "./validation";
import type { Context } from "hono";

/** Form routes whose schema-level validation maps back to an Inertia page. */
const COMPONENT_BY_PATH: Record<string, string> = {
  "/register": "Register",
  "/login": "Login",
  "/forgot-password": "ForgotPassword",
  "/reset-password": "ResetPassword",
  "/profile": "Profile",
  "/profile/password": "Profile",
};

const VALIDATION_MESSAGES_ALL = {
  ...VALIDATION_MESSAGES,
  ...PROFILE_VALIDATION_MESSAGES,
};

/**
 * Build the Inertia adapter for error/not-found paths. The global
 * inertiaMiddleware has already run for every request, so `c.var.inertia`
 * is normally set; the fallback only covers exotic failures before it ran.
 */
function inertiaFromContext(
  c: Context<AppEnv>,
  assets: InertiaAssets,
): Inertia {
  const existing = c.get("inertia");
  if (existing) return existing;
  const raw = getCookie(c, SESSION_COOKIE);
  const sessionToken = typeof raw === "string" && raw.length > 0 ? raw : null;
  // Fallback path: resolveUser/readFlash are async, but this branch is
  // exotic (inertiaMiddleware didn't run). We pass null user + empty flash
  // — the real middleware always populates c.var.inertia.
  return new Inertia(
    {
      request: c.req.raw,
      headers: Object.fromEntries(c.req.raw.headers.entries()),
      user: null,
      flash: {},
      sessionToken,
    },
    assets,
  );
}

export function createApp(assets: InertiaAssets) {
  const app = new Hono<AppEnv>();

  app.use(requestLogger);
  app.use(checkOrigin);
  // Compression: Wrangler/Miniflare auto-compresses responses with gzip/br.
  // No custom compress middleware needed (unlike Bun which lacked this).
  app.use(
    secureHeaders({
      xFrameOptions: "DENY",
      referrerPolicy: "strict-origin-when-cross-origin",
      permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
      // script-src/style-src 'unsafe-inline': Inertia embeds the page
      // payload as an inline <script type="application/json"> plus the
      // theme-boot script, and the progress bar injects inline styles.
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    }),
  );
  app.use(inertiaMiddleware(assets));
  // Global rate limit (DDoS baseline) — applied to all routes except
  // /health (orchestrator probes), /assets/* (bulk browser fetches), and
  // /.well-known/* (DevTools probes). Auth endpoints get a stricter layer
  // on top (see auth.routes.ts). KV-backed (see rate-limit.ts).
  const globalLimiter = rateLimit({
    max: config.rateLimit.globalMax,
    windowSeconds: config.rateLimit.globalWindow,
    scope: "global",
  });
  const EXEMPT_PREFIXES = ["/assets/", "/.well-known/"] as const;
  app.use((c, next) => {
    const pathname = safeUrl(c.req.url).pathname;
    if (
      pathname === "/health" ||
      EXEMPT_PREFIXES.some((p) => pathname.startsWith(p))
    )
      return next();
    return globalLimiter(c, next);
  });

  app.onError(async (err, c) => {
    logError(c, err);
    const pathname = safeUrl(c.req.url).pathname;

    if (err instanceof HTTPException) return err.getResponse();

    // Schema validation (TypeBox) → 422 with field errors, Inertia-aware.
    if (err instanceof ValidationFailed) {
      const component = COMPONENT_BY_PATH[pathname];
      const errors: Record<string, string> = {};
      for (const item of err.errors) {
        const field = item.path.replace(/^\//, "");
        if (field && !errors[field])
          errors[field] = VALIDATION_MESSAGES_ALL[item.path] ?? item.message;
      }
      if (!component) return c.json({ errors }, 422);
      return inertiaFromContext(c, assets).error(component, errors);
    }

    return c.text("Internal Server Error", 500);
  });

  app.notFound((c) =>
    inertiaFromContext(c, assets).render("NotFound", {}, { status: 404 }),
  );

  app.get("/health", async (c) => {
    await pingDb();
    return c.json({ status: "ok" });
  });
  // Browser/DevTools well-known probes — return a plain 404.
  app.get("/.well-known/*", () => new Response(null, { status: 404 }));

  app.route("/", authRoutes());
  app.route("/", googleOauthRoutes());
  app.route("/", pageRoutes());
  app.route("/", profileRoutes());

  return app;
}
