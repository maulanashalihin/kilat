/**
 * Request logging + correlation id — structured JSON for Workers Observability.
 *
 * Cloudflare's log pipeline indexes JSON-structured console output, making
 * logs searchable and filterable in the dashboard. Each log line is a
 * single JSON object with a stable schema.
 *
 * /health and /assets/* produce no log line (infrastructure noise).
 * Errors use console.error so they surface at "error" severity.
 */
import type { Context, Next } from "hono";
import type { AppEnv } from "./inertia-middleware";
import { safeUrl } from "./url";

const SILENT_PATHS: RegExp[] = [/^\/health$/, /^\/assets\//];

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Log level — matches Workers Observability severity buckets. */
type LogLevel = "info" | "warn" | "error";

/** Emit a structured JSON log line. Single-line JSON.stringify ensures the
 *  log pipeline indexes it as one entry, not split across lines. */
function log(level: LogLevel, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const requestLogger = async (c: Context<AppEnv>, next: Next) => {
  const requestId = randomId();
  const start = performance.now();
  const { pathname } = safeUrl(c.req.url);
  const method = c.req.method;
  c.set("requestId", requestId);

  const result = await next();

  const durationMs = Number((performance.now() - start).toFixed(1));
  c.res.headers.set("x-request-id", requestId);
  if (!SILENT_PATHS.some((re) => re.test(pathname))) {
    const status = c.res.status;
    log(status >= 500 ? "error" : status >= 400 ? "warn" : "info", {
      requestId,
      method,
      path: pathname,
      status,
      durationMs,
    });
  }
  return result;
};

export function logError(c: Context<AppEnv>, error: unknown): void {
  const { pathname } = safeUrl(c.req.url);
  const requestId = c.get("requestId") || "-";
  log("error", {
    requestId,
    method: c.req.method,
    path: pathname,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
  });
}
