/**
 * Unit tests for src/server/db.ts — the D1 data layer.
 * Uses the in-memory D1 mock (tests/d1-mock.ts) so no Wrangler/Miniflare needed.
 * Run with: bun test --isolate tests/db.test.ts
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
  closeD1Mock,
  createD1Mock,
  applyMigrations,
  type D1Mock,
} from "./d1-mock";
import {
  initDb,
  toPublicUser,
  // Users
  createUser,
  createUserWithRole,
  createGoogleUser,
  findUserByEmail,
  findUserById,
  findUserByGoogleId,
  linkGoogleAccount,
  updateUserPassword,
  updateUserAvatar,
  updateUserProfile,
  countUsers,
  listUsers,
  recentUsers,
  // Sessions
  insertSession,
  findSession,
  deleteSession,
  deleteOtherSessions,
  updateSessionFlash,
  // Password resets
  insertPasswordReset,
  findPasswordReset,
  deletePasswordResetsByEmail,
  // Email verifications
  insertEmailVerification,
  findEmailVerification,
  deleteEmailVerification,
  deleteUserEmailVerifications,
  verifyUserEmail,
  // Uploads
  insertUpload,
  findUpload,
  advanceOffset,
  deleteUpload,
  listExpired,
  // Health
  pingDb,
} from "../src/server/db";

let d1: D1Mock;

beforeAll(async () => {
  d1 = createD1Mock();
  await applyMigrations(d1);
  initDb(d1 as unknown as Parameters<typeof initDb>[0]);
});

afterAll(() => {
  closeD1Mock(d1);
});

beforeEach(async () => {
  // Clean dependent tables first (FK references), then users.
  await d1.prepare("DELETE FROM sessions").run();
  await d1.prepare("DELETE FROM email_verifications").run();
  await d1.prepare("DELETE FROM uploads").run();
  await d1.prepare("DELETE FROM password_resets").run();
  await d1.prepare("DELETE FROM users").run();
});

// ---------------------------------------------------------------------------
// Users CRUD
// ---------------------------------------------------------------------------

describe("Users CRUD", () => {
  it("createUser returns { id }", async () => {
    const result = await createUser("Alice", "alice@example.com", "hash123");
    expect(result).not.toBeNull();
    expect(typeof result?.id).toBe("number");
    expect(result!.id).toBeGreaterThan(0);
  });

  it("findUserByEmail returns the row with camelCase columns", async () => {
    await createUser("Bob", "bob@example.com", "secret-hash");
    const user = await findUserByEmail("bob@example.com");
    expect(user).not.toBeNull();
    expect(user!.id).toBeGreaterThan(0);
    expect(user!.name).toBe("Bob");
    expect(user!.email).toBe("bob@example.com");
    expect(user!.passwordHash).toBe("secret-hash");
    expect(user!.role).toBe("user");
    expect(user!.googleId).toBeNull();
    expect(user!.avatarUrl).toBeNull();
    expect(user!.emailVerified).toBe(0);
    expect(user!.createdAt).toEqual(expect.any(String));
  });

  it("findUserById returns the same row", async () => {
    const { id } = (await createUser("Carol", "carol@example.com", "h"))!;
    const user = await findUserById(id);
    expect(user).not.toBeNull();
    expect(user!.id).toBe(id);
    expect(user!.name).toBe("Carol");
    expect(user!.email).toBe("carol@example.com");
    expect(user!.passwordHash).toBe("h");
  });

  it("findUserByEmail('nonexistent') returns null", async () => {
    const user = await findUserByEmail("nobody@example.com");
    expect(user).toBeNull();
  });

  it("createUserWithRole sets the role", async () => {
    const { id } = (await createUserWithRole(
      "Admin",
      "admin@example.com",
      "admin-hash",
      "admin",
    ))!;
    const user = await findUserById(id);
    expect(user).not.toBeNull();
    expect(user!.role).toBe("admin");
  });

  it("createGoogleUser sets googleId + avatarUrl", async () => {
    const { id } = (await createGoogleUser(
      "G",
      "g@example.com",
      "google-123",
      "https://avatar.example.com/g.png",
    ))!;
    const user = await findUserByGoogleId("google-123");
    expect(user).not.toBeNull();
    expect(user!.id).toBe(id);
    expect(user!.googleId).toBe("google-123");
    expect(user!.avatarUrl).toBe("https://avatar.example.com/g.png");
  });

  it("findUserByGoogleId returns null for unknown googleId", async () => {
    const user = await findUserByGoogleId("no-such-google-id");
    expect(user).toBeNull();
  });

  it("linkGoogleAccount updates googleId", async () => {
    const { id } = (await createUser("Dave", "dave@example.com", "h"))!;
    expect((await findUserById(id))!.googleId).toBeNull();
    await linkGoogleAccount("google-dave", id);
    const user = await findUserById(id);
    expect(user!.googleId).toBe("google-dave");
  });

  it("updateUserPassword changes the hash", async () => {
    const { id } = (await createUser("Eve", "eve@example.com", "old-hash"))!;
    await updateUserPassword("new-hash", id);
    const user = await findUserById(id);
    expect(user!.passwordHash).toBe("new-hash");
  });

  it("updateUserAvatar changes avatarUrl", async () => {
    const { id } = (await createUser("Frank", "frank@example.com", "h"))!;
    await updateUserAvatar("https://avatar.example.com/frank.png", id);
    const user = await findUserById(id);
    expect(user!.avatarUrl).toBe("https://avatar.example.com/frank.png");
  });

  it("updateUserProfile changes name + email", async () => {
    const { id } = (await createUser("Grace", "grace@example.com", "h"))!;
    await updateUserProfile("Grace H", "grace.h@example.com", id);
    const user = await findUserById(id);
    expect(user!.name).toBe("Grace H");
    expect(user!.email).toBe("grace.h@example.com");
  });

  it("countUsers returns the correct count", async () => {
    expect((await countUsers())!.n).toBe(0);
    await createUser("U1", "u1@example.com", "h");
    await createUser("U2", "u2@example.com", "h");
    expect((await countUsers())!.n).toBe(2);
  });

  it("listUsers paginates with limit/offset (id DESC)", async () => {
    await createUser("P1", "p1@example.com", "h");
    await createUser("P2", "p2@example.com", "h");
    await createUser("P3", "p3@example.com", "h");
    const page1 = await listUsers(2, 0);
    expect(page1).toHaveLength(2);
    // id DESC → newest first
    expect(page1[0].email).toBe("p3@example.com");
    expect(page1[1].email).toBe("p2@example.com");
    const page2 = await listUsers(2, 2);
    expect(page2).toHaveLength(1);
    expect(page2[0].email).toBe("p1@example.com");
  });

  it("recentUsers returns the N most recent", async () => {
    await createUser("R1", "r1@example.com", "h");
    await createUser("R2", "r2@example.com", "h");
    await createUser("R3", "r3@example.com", "h");
    const recent = await recentUsers(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].email).toBe("r3@example.com");
    expect(recent[1].email).toBe("r2@example.com");
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("Sessions", () => {
  async function seedUser(): Promise<number> {
    return (await createUser("Sess User", "sess@example.com", "h"))!.id;
  }

  it("insertSession + findSession round-trip returns camelCase columns", async () => {
    const userId = await seedUser();
    await insertSession("tok-hash-1", userId, "2099-01-01T00:00:00.000Z");
    const session = await findSession("tok-hash-1");
    expect(session).not.toBeNull();
    expect(session!.tokenHash).toBe("tok-hash-1");
    expect(session!.userId).toBe(userId);
    expect(session!.flash).toBe("{}");
    expect(session!.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect(session!.createdAt).toEqual(expect.any(String));
  });

  it("findSession('nonexistent') returns null", async () => {
    const session = await findSession("no-such-token");
    expect(session).toBeNull();
  });

  it("deleteSession removes it", async () => {
    const userId = await seedUser();
    await insertSession("tok-del", userId, "2099-01-01T00:00:00.000Z");
    expect(await findSession("tok-del")).not.toBeNull();
    await deleteSession("tok-del");
    expect(await findSession("tok-del")).toBeNull();
  });

  it("deleteOtherSessions removes all except the specified token", async () => {
    const userId = await seedUser();
    await insertSession("keep", userId, "2099-01-01T00:00:00.000Z");
    await insertSession("drop1", userId, "2099-01-01T00:00:00.000Z");
    await insertSession("drop2", userId, "2099-01-01T00:00:00.000Z");
    await deleteOtherSessions(userId, "keep");
    expect(await findSession("keep")).not.toBeNull();
    expect(await findSession("drop1")).toBeNull();
    expect(await findSession("drop2")).toBeNull();
  });

  it("deleteOtherSessions does not touch other users' sessions", async () => {
    const u1 = (await createUser("U-a", "ua@example.com", "h"))!.id;
    const u2 = (await createUser("U-b", "ub@example.com", "h"))!.id;
    await insertSession("u1-tok", u1, "2099-01-01T00:00:00.000Z");
    await insertSession("u2-tok", u2, "2099-01-01T00:00:00.000Z");
    await deleteOtherSessions(u1, "u1-tok");
    expect(await findSession("u2-tok")).not.toBeNull();
  });

  it("updateSessionFlash updates the flash JSON", async () => {
    const userId = await seedUser();
    await insertSession("tok-flash", userId, "2099-01-01T00:00:00.000Z");
    await updateSessionFlash('{"msg":"hello"}', "tok-flash");
    const session = await findSession("tok-flash");
    expect(session!.flash).toBe('{"msg":"hello"}');
  });
});

// ---------------------------------------------------------------------------
// Password resets
// ---------------------------------------------------------------------------

describe("Password resets", () => {
  it("insertPasswordReset + findPasswordReset round-trip", async () => {
    await insertPasswordReset(
      "reset@example.com",
      "reset-hash-1",
      "2099-01-01T00:00:00.000Z",
    );
    const row = await findPasswordReset("reset-hash-1");
    expect(row).not.toBeNull();
    expect(row!.email).toBe("reset@example.com");
    expect(row!.tokenHash).toBe("reset-hash-1");
    expect(row!.expiresAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("findPasswordReset('nonexistent') returns null", async () => {
    expect(await findPasswordReset("no-such-reset")).toBeNull();
  });

  it("deletePasswordResetsByEmail removes all for that email", async () => {
    await insertPasswordReset("del@example.com", "rh-1", "2099-01-01T00:00:00.000Z");
    await insertPasswordReset("del@example.com", "rh-2", "2099-01-01T00:00:00.000Z");
    await insertPasswordReset("keep@example.com", "rh-3", "2099-01-01T00:00:00.000Z");
    await deletePasswordResetsByEmail("del@example.com");
    expect(await findPasswordReset("rh-1")).toBeNull();
    expect(await findPasswordReset("rh-2")).toBeNull();
    expect(await findPasswordReset("rh-3")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Email verifications
// ---------------------------------------------------------------------------

describe("Email verifications", () => {
  async function seedUser(): Promise<number> {
    return (await createUser("Ev User", "ev@example.com", "h"))!.id;
  }

  it("insertEmailVerification + findEmailVerification round-trip", async () => {
    const userId = await seedUser();
    await insertEmailVerification("ev-hash-1", userId, "2099-01-01T00:00:00.000Z");
    const row = await findEmailVerification("ev-hash-1");
    expect(row).not.toBeNull();
    expect(row!.tokenHash).toBe("ev-hash-1");
    expect(row!.userId).toBe(userId);
    expect(row!.expiresAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("findEmailVerification('nonexistent') returns null", async () => {
    expect(await findEmailVerification("no-such-ev")).toBeNull();
  });

  it("deleteEmailVerification removes it", async () => {
    const userId = await seedUser();
    await insertEmailVerification("ev-del", userId, "2099-01-01T00:00:00.000Z");
    expect(await findEmailVerification("ev-del")).not.toBeNull();
    await deleteEmailVerification("ev-del");
    expect(await findEmailVerification("ev-del")).toBeNull();
  });

  it("deleteUserEmailVerifications removes all for a user", async () => {
    const userId = await seedUser();
    await insertEmailVerification("ev-a", userId, "2099-01-01T00:00:00.000Z");
    await insertEmailVerification("ev-b", userId, "2099-01-01T00:00:00.000Z");
    await deleteUserEmailVerifications(userId);
    expect(await findEmailVerification("ev-a")).toBeNull();
    expect(await findEmailVerification("ev-b")).toBeNull();
  });

  it("verifyUserEmail sets email_verified=1", async () => {
    const { id } = (await createUser("Verify", "verify@example.com", "h"))!;
    expect((await findUserById(id))!.emailVerified).toBe(0);
    await verifyUserEmail(id);
    expect((await findUserById(id))!.emailVerified).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

describe("Uploads", () => {
  it("insertUpload + findUpload round-trip returns camelCase columns", async () => {
    await insertUpload(
      "up-1",
      1024,
      '{"foo":"bar"}',
      null,
      "/tmp/up-1",
      "2099-01-01T00:00:00.000Z",
    );
    const row = await findUpload("up-1");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("up-1");
    expect(row!.uploadLength).toBe(1024);
    expect(row!.offset).toBe(0);
    expect(row!.metadata).toBe('{"foo":"bar"}');
    expect(row!.userId).toBeNull();
    expect(row!.path).toBe("/tmp/up-1");
    expect(row!.createdAt).toEqual(expect.any(String));
    expect(row!.expiresAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("findUpload('nonexistent') returns null", async () => {
    expect(await findUpload("no-such-upload")).toBeNull();
  });

  it("advanceOffset increments offset with optimistic check", async () => {
    await insertUpload("up-adv", 2048, "{}", null, "/tmp/up-adv", null);
    // offset starts at 0
    const r1 = await advanceOffset(100, "up-adv", 0);
    expect(r1).not.toBeNull();
    expect(r1!.n).toBe(1);
    expect((await findUpload("up-adv"))!.offset).toBe(100);
    // expected mismatch (current is 100, not 999) → returns null, no change
    const r2 = await advanceOffset(50, "up-adv", 999);
    expect(r2).toBeNull();
    expect((await findUpload("up-adv"))!.offset).toBe(100);
    // correct expected → increments again
    const r3 = await advanceOffset(50, "up-adv", 100);
    expect(r3!.n).toBe(1);
    expect((await findUpload("up-adv"))!.offset).toBe(150);
  });

  it("deleteUpload removes it", async () => {
    await insertUpload("up-del", 512, "{}", null, "/tmp/up-del", null);
    expect(await findUpload("up-del")).not.toBeNull();
    await deleteUpload("up-del");
    expect(await findUpload("up-del")).toBeNull();
  });

  it("listExpired returns only expired uploads", async () => {
    await insertUpload("expired", 100, "{}", null, "/tmp/expired", "2000-01-01T00:00:00.000Z");
    await insertUpload("future", 100, "{}", null, "/tmp/future", "2099-01-01T00:00:00.000Z");
    await insertUpload("no-exp", 100, "{}", null, "/tmp/no-exp", null);
    const now = "2025-01-01T00:00:00.000Z";
    const expired = await listExpired(now);
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe("Health", () => {
  it("pingDb returns { n: 1 }", async () => {
    const result = await pingDb();
    expect(result).not.toBeNull();
    expect(result!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// toPublicUser
// ---------------------------------------------------------------------------

describe("toPublicUser", () => {
  it("strips passwordHash + googleId from UserRow", async () => {
    const { id } = (await createUser("Pub", "pub@example.com", "secret-hash"))!;
    await linkGoogleAccount("google-pub", id);
    const user = (await findUserById(id))!;
    const pub = toPublicUser(user);
    expect(pub).not.toHaveProperty("passwordHash");
    expect(pub).not.toHaveProperty("googleId");
    expect(pub.id).toBe(id);
    expect(pub.name).toBe("Pub");
    expect(pub.email).toBe("pub@example.com");
    expect(pub.role).toBe("user");
    expect(pub.avatarUrl).toBeNull();
    expect(pub.emailVerified).toBe(0);
    expect(pub.createdAt).toEqual(expect.any(String));
  });
});
