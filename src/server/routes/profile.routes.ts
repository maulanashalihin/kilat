/**
 * Profile routes at /profile — page render, profile info and password changes.
 *
 * Avatar upload: direct-to-R2 multipart upload. The client POSTs the file
 * to /profile/avatar with multipart/form-data; the Worker streams the body
 * into the R2 AVATARS bucket and stores the public URL path in
 * users.avatar_url. No tus protocol, no D1 upload metadata table needed.
 *
 * All DB/auth calls are async (D1 + Web Crypto).
 */
import { Type as t, type Static } from "@sinclair/typebox";
import { Hono } from "hono";
import {
  deleteOtherSessionsByToken,
  hashPassword,
  requireAuth,
  setFlash,
  verifyPassword,
} from "../auth";
import {
  findUserByEmail,
  findUserById,
  updateUserAvatar,
  updateUserPassword,
  updateUserProfile,
} from "../db";
import type { AppEnv } from "../inertia-middleware";
import { validateJson } from "../validation";

const infoBody = t.Object(
  {
    name: t.String({ minLength: 2, maxLength: 80 }),
    email: t.String({ format: "email" }),
  },
  { additionalProperties: false },
);
const passwordBody = t.Object(
  {
    currentPassword: t.String({ minLength: 1 }),
    password: t.String({ minLength: 8, maxLength: 72 }),
    passwordConfirmation: t.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

type InfoBody = Static<typeof infoBody>;
type PasswordBody = Static<typeof passwordBody>;

/** Field messages for the profile forms (merged into VALIDATION_MESSAGES in app.ts). */
export const PROFILE_VALIDATION_MESSAGES: Record<string, string> = {
  "/name": "Name must be at least 2 characters.",
  "/currentPassword": "Enter your current password.",
  "/passwordConfirmation": "Confirm your password.",
};

/** Max avatar file size — 2 MB. R2 streaming handles the body, but we cap
 *  to prevent abuse. Workers has a 100 MB request body limit; 2 MB is
 *  plenty for a profile picture and keeps R2 storage costs predictable. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Raster-only: SVG can carry inline scripts, so we reject it even though
 *  the CSP blocks inline scripts. Defense in depth. */
const AVATAR_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Generate a random R2 key for the avatar: avatars/{userId}/{random}.ext */
function avatarKey(userId: number, filetype: string): string {
  const ext = filetype.split("/")[1] ?? "bin";
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(rand)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `avatars/${userId}/${hex}.${ext}`;
}

export const profileRoutes = () => {
  const app = new Hono<AppEnv>();

  app.get("/profile", requireAuth, (c) => c.var.inertia.render("Profile", {}));

  app.post("/profile/avatar", requireAuth, async (c) => {
    const user = c.var.user;
    if (!user) return new Response("Unauthorized", { status: 401 });

    const bucket = c.env?.AVATARS;
    if (!bucket)
      return new Response(
        "Avatar storage not configured. Enable R2 at https://dash.cloudflare.com → R2, then run: npx wrangler r2 bucket create kilat-avatars",
        { status: 503 },
      );

    // Multipart form-data: expect a single "file" field.
    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return new Response("No file uploaded", { status: 422 });
    }
    if (file.size > MAX_AVATAR_BYTES) {
      return new Response("File too large (max 2 MB)", { status: 413 });
    }
    if (!AVATAR_TYPES.includes(file.type)) {
      return new Response("Only PNG, JPEG, GIF, and WebP images are allowed", {
        status: 422,
      });
    }

    const key = avatarKey(user.id, file.type);
    await bucket.put(key, file.stream(), {
      httpMetadata: { contentType: file.type },
    });

    // Store the public URL path (served by avatars.routes.ts).
    await updateUserAvatar(`/avatars/${key}`, user.id);
    return new Response(null, { status: 204 });
  });

  app.patch("/profile", requireAuth, validateJson(infoBody), async (c) => {
    const user = c.var.user;
    if (!user) return new Response("Unauthorized", { status: 401 });
    const body = c.req.valid("json") as InfoBody;
    const existing = await findUserByEmail(body.email);
    if (existing && existing.id !== user.id) {
      return c.var.inertia.error("Profile", {
        email: "That email is already registered.",
      });
    }
    await updateUserProfile(body.name, body.email, user.id);
    if (c.var.sessionToken)
      await setFlash(c.var.sessionToken, { success: "Profile updated." });
    return c.var.inertia.redirect("/profile");
  });

  app.post(
    "/profile/password",
    requireAuth,
    validateJson(passwordBody),
    async (c) => {
      const user = c.var.user;
      if (!user) return new Response("Unauthorized", { status: 401 });
      const body = c.req.valid("json") as PasswordBody;
      if (body.password !== body.passwordConfirmation) {
        return c.var.inertia.error("Profile", {
          password: "Password confirmation does not match.",
        });
      }
      const full = await findUserById(user.id);
      if (!full) return new Response("Unauthorized", { status: 401 });
      if (!(await verifyPassword(body.currentPassword, full.passwordHash))) {
        return c.var.inertia.error("Profile", {
          currentPassword: "Your current password is incorrect.",
        });
      }
      const passwordHash = await hashPassword(body.password);
      await updateUserPassword(passwordHash, user.id);
      if (c.var.sessionToken) {
        await deleteOtherSessionsByToken(c.var.sessionToken, user.id);
        await setFlash(c.var.sessionToken, { success: "Password updated." });
      }
      return c.var.inertia.redirect("/profile");
    },
  );

  return app;
};
