/**
 * Unit tests for src/server/auth.ts — password hashing, token hashing,
 * timing-safe comparison, sessions, flash messages, password reset tokens,
 * and email verification tokens. Backed by the in-memory D1 mock.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  clearFlash,
  clearPasswordResets,
  createEmailVerification,
  createPasswordReset,
  createSession,
  deleteOtherSessionsByToken,
  deleteSessionByToken,
  hashPassword,
  hashToken,
  readFlash,
  resolveUser,
  setFlash,
  verifyEmailToken,
  verifyPassword,
  verifyPasswordReset,
} from "../src/server/auth";
import { createUser } from "../src/server/db";
import { initDb } from "../src/server/db";
import { initConfig } from "../src/server/config";
import {
  applyMigrations,
  closeD1Mock,
  createD1Mock,
  type D1Mock,
} from "./d1-mock";

let d1: D1Mock;
let userId: number;

beforeAll(async () => {
  initConfig({});
  d1 = createD1Mock();
  await applyMigrations(d1);
  initDb(d1 as unknown as Parameters<typeof initDb>[0]);
  const row = await createUser(
    "test",
    "test@example.com",
    await hashPassword("pass123"),
  );
  userId = row!.id;
});

afterAll(() => {
  closeD1Mock(d1);
});

beforeEach(async () => {
  // Wipe transient token tables so every test starts from a clean slate.
  await d1.exec("DELETE FROM sessions;");
  await d1.exec("DELETE FROM password_resets;");
  await d1.exec("DELETE FROM email_verifications;");
});

// ---------------------------------------------------------------------------
// 1. Password hashing (PBKDF2)
// ---------------------------------------------------------------------------

describe("hashPassword / verifyPassword", () => {
  it("round-trips: a correct password verifies", async () => {
    const stored = await hashPassword("s3cret!");
    expect(await verifyPassword("s3cret!", stored)).toBe(true);
  });

  it("a wrong password does not verify", async () => {
    const stored = await hashPassword("s3cret!");
    expect(await verifyPassword("wrong-password", stored)).toBe(false);
  });

  it("produces a self-describing pbkdf2:iterations:salt:hash format", async () => {
    const stored = await hashPassword("abc");
    const parts = stored.split(":");
    expect(parts[0]).toBe("pbkdf2");
    // iterations is a positive integer
    expect(Number.isInteger(Number(parts[1]))).toBe(true);
    expect(Number(parts[1])).toBeGreaterThan(0);
    // salt is 16 bytes → 32 hex chars; hash is 32 bytes → 64 hex chars
    expect(parts[2]!.length).toBe(32);
    expect(parts[3]!.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(parts[2]!)).toBe(true);
    expect(/^[0-9a-f]+$/.test(parts[3]!)).toBe(true);
  });

  it("uses a fresh salt per call (two hashes of the same password differ)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    // ...yet both verify against the original password.
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("rejects a malformed stored hash (no pbkdf2 prefix)", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Token hashing (SHA-256, hex, deterministic)
// ---------------------------------------------------------------------------

describe("hashToken", () => {
  it("is deterministic: same input → same output", async () => {
    const a = await hashToken("raw-token-abc");
    const b = await hashToken("raw-token-abc");
    expect(a).toBe(b);
  });

  it("different inputs → different outputs", async () => {
    const a = await hashToken("raw-token-abc");
    const b = await hashToken("raw-token-xyz");
    expect(a).not.toBe(b);
  });

  it("produces a 64-char lowercase hex SHA-256 digest", async () => {
    const out = await hashToken("some-token");
    expect(out.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(out)).toBe(true);
    // Matches a direct Web Crypto SHA-256 of the same input.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("some-token"),
    );
    const expected = Array.from(new Uint8Array(digest))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    expect(out).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 3. timingSafeEqual (exercised via verifyPassword, the sole caller)
//    timingSafeEqual is module-private, so we drive it through the public
//    verifyPassword surface, which covers equal / unequal / length-mismatch.
// ---------------------------------------------------------------------------

describe("timingSafeEqual (via verifyPassword)", () => {
  it("equal arrays → true (correct password)", async () => {
    const stored = await hashPassword("hunter2");
    expect(await verifyPassword("hunter2", stored)).toBe(true);
  });

  it("unequal arrays of equal length → false (wrong password)", async () => {
    const stored = await hashPassword("hunter2");
    // Wrong password derives a different 32-byte digest (same length).
    expect(await verifyPassword("hunterX", stored)).toBe(false);
  });

  it("different lengths → false (truncated stored digest)", async () => {
    // Craft a stored hash whose digest is only 1 byte, while the derived
    // digest is 32 bytes — exercises the length-mismatch early return.
    const saltHex = "00".repeat(16);
    const stored = `pbkdf2:100000:${saltHex}:ab`;
    expect(await verifyPassword("anything", stored)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Sessions
// ---------------------------------------------------------------------------

describe("sessions", () => {
  it("createSession returns a token and a future expiry", async () => {
    const { token, expiresAt } = await createSession(userId);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(expiresAt instanceof Date).toBe(true);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("resolveUser returns the user for a valid token", async () => {
    const { token } = await createSession(userId);
    const user = await resolveUser(token);
    expect(user).not.toBeNull();
    expect(user!.id).toBe(userId);
    expect(user!.email).toBe("test@example.com");
  });

  it("resolveUser(null) returns null", async () => {
    expect(await resolveUser(null)).toBeNull();
  });

  it("resolveUser(undefined) returns null", async () => {
    expect(await resolveUser(undefined)).toBeNull();
  });

  it("resolveUser(invalidToken) returns null", async () => {
    expect(await resolveUser("not-a-real-session-token")).toBeNull();
  });

  it("deleteSessionByToken removes the session", async () => {
    const { token } = await createSession(userId);
    expect(await resolveUser(token)).not.toBeNull();
    await deleteSessionByToken(token);
    expect(await resolveUser(token)).toBeNull();
  });

  it("deleteOtherSessionsByToken keeps the current session, removes others", async () => {
    const current = await createSession(userId);
    const other1 = await createSession(userId);
    const other2 = await createSession(userId);

    await deleteOtherSessionsByToken(current.token, userId);

    // Current session survives.
    expect(await resolveUser(current.token)).not.toBeNull();
    // Other sessions are gone.
    expect(await resolveUser(other1.token)).toBeNull();
    expect(await resolveUser(other2.token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Flash messages
// ---------------------------------------------------------------------------

describe("flash messages", () => {
  it("setFlash then readFlash returns the stored payload", async () => {
    const { token } = await createSession(userId);
    await setFlash(token, { success: "ok" });
    expect(await readFlash(token)).toEqual({ success: "ok" });
  });

  it("readFlash on a session with no flash returns {}", async () => {
    const { token } = await createSession(userId);
    expect(await readFlash(token)).toEqual({});
  });

  it("readFlash(null) returns {}", async () => {
    expect(await readFlash(null)).toEqual({});
  });

  it("clearFlash empties the flash payload", async () => {
    const { token } = await createSession(userId);
    await setFlash(token, { error: "boom" });
    expect(await readFlash(token)).toEqual({ error: "boom" });
    await clearFlash(token);
    expect(await readFlash(token)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 6. Password reset tokens
// ---------------------------------------------------------------------------

describe("password reset", () => {
  const email = "reset@example.com";

  it("createPasswordReset returns a non-empty raw token", async () => {
    const token = await createPasswordReset(email);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("verifyPasswordReset returns true for the correct token", async () => {
    const token = await createPasswordReset(email);
    expect(await verifyPasswordReset(email, token)).toBe(true);
  });

  it("verifyPasswordReset returns false for a wrong token", async () => {
    await createPasswordReset(email);
    expect(await verifyPasswordReset(email, "wrong-token")).toBe(false);
  });

  it("verifyPasswordReset returns false for a mismatched email", async () => {
    const token = await createPasswordReset(email);
    expect(await verifyPasswordReset("other@example.com", token)).toBe(false);
  });

  it("clearPasswordResets removes all tokens for the email", async () => {
    const token = await createPasswordReset(email);
    expect(await verifyPasswordReset(email, token)).toBe(true);
    await clearPasswordResets(email);
    expect(await verifyPasswordReset(email, token)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Email verification tokens
// ---------------------------------------------------------------------------

describe("email verification", () => {
  it("createEmailVerification returns a non-empty raw token", async () => {
    const token = await createEmailVerification(userId);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("verifyEmailToken returns the userId on success", async () => {
    const token = await createEmailVerification(userId);
    expect(await verifyEmailToken(token)).toBe(userId);
  });

  it("verifyEmailToken returns null for an unknown token", async () => {
    expect(await verifyEmailToken("does-not-exist")).toBeNull();
  });

  it("consumes the token after a successful verification", async () => {
    const token = await createEmailVerification(userId);
    expect(await verifyEmailToken(token)).toBe(userId);
    // Second use fails because the token was deleted.
    expect(await verifyEmailToken(token)).toBeNull();
  });

  it("createEmailVerification replaces any prior token for the user", async () => {
    const first = await createEmailVerification(userId);
    const second = await createEmailVerification(userId);
    // The first token is invalidated when the second is created.
    expect(await verifyEmailToken(first)).toBeNull();
    expect(await verifyEmailToken(second)).toBe(userId);
  });
});
