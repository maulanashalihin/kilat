/**
 * Validation unit tests — `validateJson` middleware + `ValidationFailed`
 * error contract + the `email` string format registered by the module.
 * No D1/KV bindings needed: validation is pure TypeBox + Hono.
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { FormatRegistry, Type as t, type TSchema } from "@sinclair/typebox";
import { validateJson, ValidationFailed } from "../src/server/validation";

/** Build a throwaway Hono app whose only route validates `schema` and
 *  echoes the parsed body back. Errors are mapped to the same shapes the
 *  real app uses (422 for ValidationFailed, 400 for malformed JSON). */
function buildApp(schema: TSchema) {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ValidationFailed) {
      return c.json({ errors: err.errors }, 422);
    }
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    return c.text("err", 500);
  });
  app.post("/test", validateJson(schema), (c) => c.json(c.req.valid("json")));
  return app;
}

/** POST JSON to /test and return the Response. */
function postJson(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request("/test", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const userSchema = t.Object({
  name: t.String(),
  email: t.String({ format: "email" }),
});

describe("validateJson", () => {
  it("passes a valid body through to c.req.valid('json')", async () => {
    const app = buildApp(userSchema);
    const res = await postJson(app, { name: "Ada", email: "ada@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Ada", email: "ada@example.com" });
  });

  it("rejects a missing required field with a /name path", async () => {
    const app = buildApp(userSchema);
    const res = await postJson(app, { email: "ada@example.com" });
    expect(res.status).toBe(422);
    const body = await res.json();
    const paths = body.errors.map((e: { path: string }) => e.path);
    expect(paths).toContain("/name");
  });

  it("rejects a wrong-typed field (number for string)", async () => {
    const app = buildApp(userSchema);
    const res = await postJson(app, { name: 123, email: "ada@example.com" });
    expect(res.status).toBe(422);
    const body = await res.json();
    const nameErr = body.errors.find(
      (e: { path: string }) => e.path === "/name",
    );
    expect(nameErr).toBeDefined();
  });

  it("rejects an invalid email with a /email path", async () => {
    const app = buildApp(userSchema);
    const res = await postJson(app, { name: "Ada", email: "not-an-email" });
    expect(res.status).toBe(422);
    const body = await res.json();
    const paths = body.errors.map((e: { path: string }) => e.path);
    expect(paths).toContain("/email");
  });

  it("rejects extra properties when additionalProperties is false", async () => {
    const strictSchema = t.Object(
      { name: t.String(), email: t.String({ format: "email" }) },
      { additionalProperties: false },
    );
    const app = buildApp(strictSchema);
    const res = await postJson(app, {
      name: "Ada",
      email: "ada@example.com",
      extra: "boom",
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    // TypeBox reports the unexpected key under its own path.
    const paths = body.errors.map((e: { path: string }) => e.path);
    expect(paths.some((p: string) => p.includes("extra"))).toBe(true);
  });

  it("rejects an empty body when the schema requires fields", async () => {
    const app = buildApp(userSchema);
    const res = await postJson(app, {});
    expect(res.status).toBe(422);
    const body = await res.json();
    const paths = body.errors.map((e: { path: string }) => e.path);
    expect(paths).toContain("/name");
    expect(paths).toContain("/email");
  });

  it("returns 400 for malformed JSON with a JSON content-type", async () => {
    const app = buildApp(userSchema);
    const res = await postJson(app, "{ this is not json");
    expect(res.status).toBe(400);
  });

  it("defaults the body to {} for non-JSON content-type and runs validation", async () => {
    const app = buildApp(userSchema);
    // form-urlencoded is NOT a JSON content-type, so the middleware skips
    // c.req.json() and validates the default {} — required fields fail.
    const res = await app.request("/test", {
      method: "POST",
      body: "name=Ada&email=ada@example.com",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    const paths = body.errors.map((e: { path: string }) => e.path);
    expect(paths).toContain("/name");
  });
});

describe("ValidationFailed error structure", () => {
  it("exposes errors as an array of { path, message } objects", async () => {
    const app = buildApp(userSchema);
    const res = await postJson(app, { email: "bad" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
    for (const e of body.errors) {
      expect(typeof e.path).toBe("string");
      expect(typeof e.message).toBe("string");
    }
  });
});

describe("email format registry", () => {
  it("accepts a@b.c and rejects abc", () => {
    // Importing validation.ts registers the 'email' format as a side effect.
    const check = FormatRegistry.Get("email");
    expect(typeof check).toBe("function");
    expect(check?.("a@b.c")).toBe(true);
    expect(check?.("abc")).toBe(false);
  });
});
