/**
 * Cloudflare Workers entry point.
 *
 * Replaces Bun.serve: the Workers runtime calls `fetch` per request.
 * `env` carries D1 + ASSETS bindings and environment variables.
 * Hono stores the 2nd fetch arg as `c.env` — same pattern as Bun.serve.
 */
import { createApp } from "./server/app";
import { initConfig, type EnvVars } from "./server/config";
import { initDb } from "./server/db";
import { initSessionCache } from "./server/auth";
import manifest from "../dist/manifest.json";
import type { InertiaAssets } from "./server/inertia";

export interface Env extends EnvVars {
  DB: D1Database;
  ASSETS: Fetcher;
  AVATARS: R2Bucket;
  SESSION_KV?: KVNamespace;
}

const assets = manifest as InertiaAssets;
const app = createApp(assets);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    initDb(env.DB);
    initSessionCache(env.SESSION_KV);
    return app.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
