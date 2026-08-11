/**
 * Auth routes: register / login / logout / forgot-password / reset-password —
 * page renders and form actions together (see AGENTS.md "Route conventions").
 *
 * All DB/auth calls are async (D1 + Web Crypto).
 */
import { Type as t, type Static } from "@sinclair/typebox";
import { Hono } from "hono";
import {
  clearPasswordResets,
  clearSessionCookie,
  createPasswordReset,
  createSession,
  deleteSessionByToken,
  guestOnly,
  hashPassword,
  requireAuth,
  setFlash,
  setSessionCookie,
  verifyPassword,
  verifyPasswordReset,
} from "../auth";
import { config } from "../config";
import { createUser, findUserByEmail, updateUserPassword } from "../db";
import type { AppEnv } from "../inertia-middleware";
import { sendMail } from "../mailer";
import { rateLimit } from "../rate-limit";
import { validateJson } from "../validation";

// `additionalProperties: false` keeps the strict-by-default behavior Elysia's
// TypeBox wrapper had (plain @sinclair/typebox allows extra props).
const registerBody = t.Object(
  {
    name: t.String({ minLength: 2, maxLength: 50 }),
    email: t.String({ format: "email" }),
    password: t.String({ minLength: 8, maxLength: 100 }),
  },
  { additionalProperties: false },
);
const loginBody = t.Object(
  {
    email: t.String({ format: "email" }),
    password: t.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const forgotPasswordBody = t.Object(
  { email: t.String({ format: "email" }) },
  { additionalProperties: false },
);
const resetPasswordBody = t.Object(
  {
    email: t.String({ format: "email" }),
    token: t.String({ minLength: 1 }),
    password: t.String({ minLength: 8, maxLength: 100 }),
    passwordConfirmation: t.String(),
  },
  { additionalProperties: false },
);

type RegisterBody = Static<typeof registerBody>;
type LoginBody = Static<typeof loginBody>;
type ForgotPasswordBody = Static<typeof forgotPasswordBody>;
type ResetPasswordBody = Static<typeof resetPasswordBody>;

/** One-shot notice shown on the login page after redirects with ?notice=. */
const LOGIN_NOTICES: Record<string, string> = {
  password_reset: "Your password has been reset. Please log in.",
  google_failed: "Google sign-in failed. Please try again.",
  logout: "You have been logged out.",
};

/**
 * Friendly per-field messages. TypeBox surfaces raw messages (e.g. "Expected
 * string length greater or equal to 2"), so we map by the failing field path.
 */
export const VALIDATION_MESSAGES: Record<string, string> = {
  "/name": "Name must be 2–50 characters.",
  "/email": "Please enter a valid email address.",
  "/password": "Password must be at least 8 characters.",
  "/passwordConfirmation": "Password confirmation does not match.",
  "/token": "This reset link is invalid or has expired.",
};

export const authRoutes = () => {
  const app = new Hono<AppEnv>();

  app.use(
    rateLimit({
      max: config.rateLimit.authMax,
      windowSeconds: config.rateLimit.authWindow,
      scope: "auth",
      // This limiter lives on a sub-app mounted at "/" — without a path
      // filter it would throttle every route (see rate-limit.ts).
      paths: ["/login", "/register", "/forgot-password", "/reset-password", "/logout"],
    }),
  );

  app.get("/login", guestOnly, (c) => {
    const noticeParam = c.req.query("notice");
    return c.var.inertia.render("Login", {
      googleEnabled: Boolean(config.google.clientId),
      notice: noticeParam ? (LOGIN_NOTICES[noticeParam] ?? null) : null,
    });
  });
  app.get("/register", guestOnly, (c) =>
    c.var.inertia.render("Register", {
      googleEnabled: Boolean(config.google.clientId),
    }),
  );
  app.get("/forgot-password", guestOnly, (c) =>
    c.var.inertia.render("ForgotPassword"),
  );
  app.get("/reset-password", guestOnly, (c) =>
    c.var.inertia.render("ResetPassword", {
      email: c.req.query("email") ?? "",
      token: c.req.query("token") ?? "",
    }),
  );

  app.post("/register", validateJson(registerBody), async (c) => {
    const body = c.req.valid("json") as RegisterBody;
    const page = c.var.inertia;
    if (await findUserByEmail(body.email)) {
      return page.error("Register", {
        email: "That email is already registered.",
      });
    }
    const passwordHash = await hashPassword(body.password);
    const user = await createUser(body.name, body.email, passwordHash);
    if (!user)
      return page.error("Register", {
        email: "Could not create your account.",
      });
    // Rotate the session cookie if one exists (session fixation defense).
    if (c.var.sessionToken) await deleteSessionByToken(c.var.sessionToken);
    const session = await createSession(user.id);
    setSessionCookie(c, session.token, session.expiresAt);
    return page.redirect("/dashboard");
  });

  app.post("/login", validateJson(loginBody), async (c) => {
    const body = c.req.valid("json") as LoginBody;
    const page = c.var.inertia;
    const user = await findUserByEmail(body.email);
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return page.error("Login", {
        email: "These credentials do not match our records.",
      });
    }
    // Rotate the session cookie if one exists (session fixation defense).
    if (c.var.sessionToken) await deleteSessionByToken(c.var.sessionToken);
    const session = await createSession(user.id);
    setSessionCookie(c, session.token, session.expiresAt);
    await setFlash(session.token, { success: `Welcome back, ${user.name}!` });
    return page.redirect("/dashboard");
  });

  app.post("/logout", requireAuth, async (c) => {
    if (c.var.sessionToken) await deleteSessionByToken(c.var.sessionToken);
    clearSessionCookie(c);
    return c.var.inertia.redirect("/login");
  });

  app.post("/forgot-password", validateJson(forgotPasswordBody), async (c) => {
    const body = c.req.valid("json") as ForgotPasswordBody;
    // Always answer the same way (no user enumeration); the reset email
    // is only sent when the account exists.
    const user = await findUserByEmail(body.email);
    if (user) {
      const token = await createPasswordReset(user.email);
      const link = `${new URL(c.req.url).origin}/reset-password?email=${encodeURIComponent(user.email)}&token=${token}`;
      await sendMail({
        to: user.email,
        subject: "Reset your password",
        text: `Reset your password:\n${link}\n\nThis link expires in 60 minutes.`,
        html: `<p>We received a request to reset your password.</p><p><a href="${link}">Reset password</a></p><p>This link expires in 60 minutes. If you did not request this, you can ignore this email.</p>`,
      }).catch((err) =>
        console.error("[mail] failed to send reset email:", err),
      );
    }
    return c.var.inertia.render("ForgotPassword", { status: "sent" });
  });

  app.post("/reset-password", validateJson(resetPasswordBody), async (c) => {
    const body = c.req.valid("json") as ResetPasswordBody;
    const page = c.var.inertia;
    if (body.password !== body.passwordConfirmation) {
      return page.error("ResetPassword", {
        password: "Password confirmation does not match.",
      });
    }
    const valid = await verifyPasswordReset(body.email, body.token);
    const user = valid ? await findUserByEmail(body.email) : null;
    if (!user) {
      return page.error("ResetPassword", {
        token: "This reset link is invalid or has expired.",
      });
    }
    const passwordHash = await hashPassword(body.password);
    await updateUserPassword(passwordHash, user.id);
    await clearPasswordResets(user.email);
    return page.redirect("/login?notice=password_reset");
  });

  return app;
};
