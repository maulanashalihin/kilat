/**
 * Avatar serving — streams objects from the R2 AVATARS bucket.
 *
 * GET /avatars/* → R2 GET by key. The key path is stored in
 * users.avatar_url as /avatars/{key} by the profile avatar upload route.
 *
 * R2 binding is optional at the type level (tests / local dev without the
 * binding get a 503). In production the binding is always present.
 */
import { Hono } from "hono";
import type { AppEnv } from "../inertia-middleware";
import { safeUrl } from "../url";

export const avatarRoutes = () => {
  const app = new Hono<AppEnv>();

  app.get("/avatars/*", async (c) => {
    const bucket = c.env?.AVATARS;
    if (!bucket)
      return new Response(
        "Avatar storage not configured. Enable R2 at https://dash.cloudflare.com → R2, then run: npx wrangler r2 bucket create kilat-avatars",
        { status: 503 },
      );

    // Strip the leading "/avatars/" prefix to get the R2 key.
    const key = decodeURIComponent(
      safeUrl(c.req.url).pathname.slice("/avatars/".length),
    );
    if (!key) return new Response("Not found", { status: 404 });

    const object = await bucket.get(key);
    if (object === null) return new Response("Not found", { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    // Cache avatars for 1 hour on the edge — they change rarely and the
    // URL includes a random key so stale cache is never served after update.
    headers.set("cache-control", "public, max-age=3600");
    return new Response(object.body, { headers });
  });

  return app;
};
