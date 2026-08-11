/**
 * Centralised, validated configuration. In the Workers runtime, env vars
 * arrive via the `env` binding (not process.env). `initConfig(env)` is
 * called per-request in the fetch handler before the app processes anything.
 *
 * The `config` object is mutable — its fields are set by `initConfig` and
 * read by other modules at request time. No module reads config at import
 * time (that would race with `initConfig`).
 */
export type MailDriver = "log" | "resend" | "mailtrap";
export type Role = "user" | "admin";

/** Environment variables passed from wrangler `[vars]` + secrets. */
export interface EnvVars {
  NODE_ENV?: string;
  SSR?: string;
  MAIL_DRIVER?: string;
  MAIL_FROM?: string;
  RESEND_API_KEY?: string;
  MAILTRAP_API_TOKEN?: string;
  MAILTRAP_INBOX_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RATE_LIMIT_GLOBAL_MAX?: string;
  RATE_LIMIT_GLOBAL_WINDOW?: string;
  RATE_LIMIT_AUTH_MAX?: string;
  RATE_LIMIT_AUTH_WINDOW?: string;
}

const pick = <T>(value: T | undefined, fallback: T): T =>
  value === undefined || value === "" ? fallback : value;

export const config = {
  isProd: false,
  /** Server-side rendering of Inertia pages. Set SSR=false to ship an empty
   *  shell and let the client render (faster boot, no react-dom/server cost). */
  ssr: true,
  mail: {
    driver: "log" as MailDriver,
    from: "no-reply@example.com",
    resendApiKey: "",
    mailtrapToken: "",
    mailtrapInboxId: "",
  },
  google: {
    clientId: null as string | null,
    clientSecret: null as string | null,
  },
  rateLimit: {
    /** Baseline DDoS protection — all routes except /health, /assets, /.well-known. */
    globalMax: 200,
    globalWindow: 60,
    /** Stricter layer on auth endpoints (brute-force protection). */
    authMax: 30,
    authWindow: 60,
  },
};

/** Validate and populate `config` from the Workers env binding. Called once
 *  per request in the fetch handler (cheap — just field assignments). */
export function initConfig(env: EnvVars): void {
  const problems: string[] = [];

  const mailDriver = (env.MAIL_DRIVER ?? "log").toLowerCase() as MailDriver;
  if (!["log", "resend", "mailtrap"].includes(mailDriver)) {
    problems.push(
      `MAIL_DRIVER must be one of log|resend|mailtrap (got "${mailDriver}")`,
    );
  }
  const resendApiKey = env.RESEND_API_KEY ?? "";
  if (mailDriver === "resend" && !resendApiKey)
    problems.push("MAIL_DRIVER=resend requires RESEND_API_KEY");
  const mailtrapToken = env.MAILTRAP_API_TOKEN ?? "";
  if (mailDriver === "mailtrap" && !mailtrapToken)
    problems.push("MAIL_DRIVER=mailtrap requires MAILTRAP_API_TOKEN");

  const googleClientId = env.GOOGLE_CLIENT_ID ?? "";
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET ?? "";
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    problems.push(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together (Google OAuth stays disabled otherwise)",
    );
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }

  config.isProd = env.NODE_ENV === "production";
  config.ssr = env.SSR !== "false";
  config.mail = {
    driver: mailDriver,
    from: pick(env.MAIL_FROM, "no-reply@example.com"),
    resendApiKey,
    mailtrapToken,
    mailtrapInboxId: env.MAILTRAP_INBOX_ID ?? "",
  };
  config.google = {
    clientId: googleClientId || null,
    clientSecret: googleClientSecret || null,
  };
  config.rateLimit = {
    globalMax: Number(pick(env.RATE_LIMIT_GLOBAL_MAX, "200")),
    globalWindow: Number(pick(env.RATE_LIMIT_GLOBAL_WINDOW, "60")),
    authMax: Number(pick(env.RATE_LIMIT_AUTH_MAX, "30")),
    authWindow: Number(pick(env.RATE_LIMIT_AUTH_WINDOW, "60")),
  };
}
