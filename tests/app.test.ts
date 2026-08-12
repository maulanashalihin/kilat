/**
 * End-to-end test suite: boots the full app (Hono + D1 mock + Inertia)
 * against an in-memory SQLite database and drives it via app.request().
 * Run with: bun test --isolate (each file gets fresh globals — the env
 * setup in beforeAll must not leak across files).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { applyMigrations, closeD1Mock, createD1Mock, type D1Mock } from "./d1-mock";

let app: Awaited<ReturnType<typeof import("../src/server/app")["createApp"]>>;
let d1: D1Mock;

beforeAll(async () => {
	// Create an in-memory D1 mock and apply migrations before importing the app
	// (db.ts reads the D1 binding at query time, not import time, but initDb
	// must be called before any route handler runs).
	d1 = createD1Mock();
	await applyMigrations(d1);
	const { initDb } = await import("../src/server/db");
	// Cast is safe: D1Mock implements the same prepare/exec shape as D1Database.
	initDb(d1 as unknown as D1Database);
	const { createApp } = await import("../src/server/app");
	app = createApp({ version: "test-version", js: "app.js", css: "app.css" });
});

afterAll(() => {
	closeD1Mock(d1);
});

const BASE = "http://localhost:3000";

interface CallOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: Record<string, unknown>;
	cookie?: string;
}

async function call(
	path: string,
	options: CallOptions = {},
): Promise<Response> {
	const headers = new Headers(options.headers);
	if (options.cookie) headers.set("cookie", options.cookie);
	let body: string | undefined;
	if (options.body) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(options.body);
	}
	return app.request(`${BASE}${path}`, {
		method: options.method ?? "GET",
		headers,
		body,
	});
}

const xhr = { "x-inertia": "true" };

/** Collect every Set-Cookie header (Bun/undici exposes getSetCookie). */
function allSetCookies(res: Response): string[] {
	const headers = res.headers as Headers & { getSetCookie?: () => string[] };
	return typeof headers.getSetCookie === "function"
		? headers.getSetCookie()
		: [res.headers.get("set-cookie") ?? ""].filter(Boolean);
}

function sessionCookie(res: Response): string {
	const cookie = allSetCookies(res).find((c) => c.startsWith("session="));
	return cookie ? cookie.split(";")[0]! : "";
}

// biome-ignore lint/suspicious/noExplicitAny: Inertia page JSON shape varies per test
async function page(res: Response): Promise<any> {
	return res.json();
}

async function registerUser(
	email: string,
	password = "password123",
): Promise<string> {
	const res = await call("/register", {
		method: "POST",
		headers: xhr,
		body: { name: "Test User", email, password },
	});
	expect(res.status).toBe(303);
	const cookie = sessionCookie(res);
	expect(cookie).not.toBe("");
	return cookie;
}

describe("auth basics", () => {
	it("redirects guests from / to /login", async () => {
		const res = await call("/");
		expect(res.status).toBe(302);
		expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
	});

	it("registers a user, creates a session cookie", async () => {
		const res = await call("/register", {
			method: "POST",
			headers: xhr,
			body: {
				name: "Ada Lovelace",
				email: "ada@example.com",
				password: "password123",
			},
		});
		expect(res.status).toBe(303);
		expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
		expect(res.headers.get("set-cookie")).toContain("session=");
		expect(res.headers.get("set-cookie")).toContain("HttpOnly");
	});

	it("rejects invalid registration with friendly field errors", async () => {
		const res = await call("/register", {
			method: "POST",
			headers: xhr,
			body: { name: "X", email: "not-an-email", password: "short" },
		});
		expect(res.status).toBe(422);
		const data = await page(res);
		expect(data.component).toBe("Register");
		expect(data.props.errors.name).toBe("Name must be at least 2 characters.");
		expect(data.props.errors.email).toBe("Please enter a valid email address.");
	});

	it("rejects duplicate email", async () => {
		await registerUser("dup@example.com");
		const res = await call("/register", {
			method: "POST",
			headers: xhr,
			body: { name: "Dup", email: "dup@example.com", password: "password123" },
		});
		expect(res.status).toBe(422);
		expect((await page(res)).props.errors.email).toBe(
			"That email is already registered.",
		);
	});

	it("rejects wrong password on login", async () => {
		await registerUser("wrongpw@example.com");
		const res = await call("/login", {
			method: "POST",
			headers: xhr,
			body: { email: "wrongpw@example.com", password: "nope-nope-123" },
		});
		expect(res.status).toBe(422);
		expect((await page(res)).props.errors.email).toContain("do not match");
	});

	it("logs in and reaches the dashboard with the user in props", async () => {
		await registerUser("loginok@example.com");
		const res = await call("/login", {
			method: "POST",
			headers: xhr,
			body: { email: "loginok@example.com", password: "password123" },
		});
		expect(res.status).toBe(303);
		const cookie = sessionCookie(res);
		expect(cookie).not.toBe("");

		const dash = await call("/dashboard", { headers: { ...xhr, cookie } });
		expect(dash.status).toBe(200);
		const data = await page(dash);
		expect(data.component).toBe("Dashboard");
		expect(data.props.auth.user.email).toBe("loginok@example.com");
		// password hashes must never reach the client
		expect(JSON.stringify(data.props)).not.toContain("passwordHash");
	});

	it("protects the dashboard without a session", async () => {
		const res = await call("/dashboard");
		expect(res.status).toBe(302);
		expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
	});

	it("keeps guest pages off limits for logged-in users", async () => {
		const cookie = await registerUser("guestguard@example.com");
		const res = await call("/login", { headers: { cookie } });
		expect(res.status).toBe(302);
		expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
	});

	it("logs out: session is destroyed server-side", async () => {
		const cookie = await registerUser("logout@example.com");
		const res = await call("/logout", {
			method: "POST",
			headers: { ...xhr, cookie },
		});
		expect(res.status).toBe(303);
		expect(new URL(res.headers.get("location")!).pathname).toBe("/login");

		const after = await call("/dashboard", { headers: { cookie } });
		expect(after.status).toBe(302); // stale cookie no longer authenticates
	});
});

describe("inertia protocol", () => {
	it("returns 409 + X-Inertia-Location on version mismatch", async () => {
		const cookie = await registerUser("version@example.com");
		const res = await call("/dashboard", {
			headers: { ...xhr, cookie, "x-inertia-version": "stale" },
		});
		expect(res.status).toBe(409);
		expect(res.headers.get("x-inertia-location")).toBe(
			"http://localhost:3000/dashboard",
		);
	});

	it("renders NotFound page payload for unknown routes", async () => {
		const res = await call("/does-not-exist", { headers: xhr });
		expect(res.status).toBe(404);
		expect((await page(res)).component).toBe("NotFound");
	});
	it("returns a valid JSON payload for XHR with gzip accept-encoding", async () => {
		// Browsers always send Accept-Encoding: gzip; the compress middleware
		// must not consume the (small) JSON body below its threshold.
		const res = await call("/login", {
			headers: { ...xhr, "accept-encoding": "gzip" },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.component).toBe("Login");
		expect(data.url).toBe("/login");
	});

	it("returns plain 404 for .well-known DevTools probes", async () => {
		const res = await call(
			"/.well-known/appspecific/com.chrome.devtools.json",
			{
				headers: xhr,
			},
		);
		expect(res.status).toBe(404);
		const body = await res.text();
		expect(body).toBe("");
	});

	it("serves full SSR HTML with security headers for browsers", async () => {
		const res = await call("/login");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('data-server-rendered="true"');
		expect(html).toContain("<title");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-security-policy")).toContain(
			"default-src 'self'",
		);
		expect(res.headers.get("x-request-id")).toBeTruthy();
	});

	it("skips SSR for authenticated routes (client-only render)", async () => {
		const cookie = await registerUser("nossr@example.com");
		const res = await call("/dashboard", { headers: { cookie } });
		expect(res.status).toBe(200);
		const html = await res.text();
		// No server-rendered HTML — client mounts from scratch via JSON payload.
		expect(html).not.toContain("data-server-rendered");
		expect(html).toContain('data-page="app"');
	});

	it("rejects cross-origin unsafe requests", async () => {
		const cookie = await registerUser("csrf@example.com");
		const res = await call("/logout", {
			method: "POST",
			headers: { ...xhr, cookie, origin: "https://evil.example" },
		});
		expect(res.status).toBe(403);
	});
});

describe("roles & admin", () => {
	it("blocks non-admins from /admin", async () => {
		const cookie = await registerUser("normal@example.com");
		const res = await call("/admin", { headers: { cookie } });
		expect(res.status).toBe(302);
		expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
	});

	it("serves paginated users to admins", async () => {
		const { createUserWithRole } = await import("../src/server/db");
		const { hashPassword } = await import("../src/server/auth");
		const hash = await hashPassword("password123");
		await createUserWithRole("Boss", "boss@example.com", hash, "admin");
		const cookie = await registerUser("filler@example.com");

		const login = await call("/login", {
			method: "POST",
			headers: xhr,
			body: { email: "boss@example.com", password: "password123" },
		});
		const adminCookie = sessionCookie(login);

		const res = await call("/admin", {
			headers: { cookie: adminCookie, ...xhr },
		});
		expect(res.status).toBe(200);
		const data = await page(res);
		expect(data.component).toBe("Admin");
		expect(data.props.users.meta.total).toBeGreaterThanOrEqual(2);
		expect(data.props.users.meta.currentPage).toBe(1);
		expect(
			data.props.users.data.some(
				(u: { email: string }) => u.email === "boss@example.com",
			),
		).toBe(true);

		// non-admin cookie is still bounced
		const blocked = await call("/admin", { headers: { cookie } });
		expect(blocked.status).toBe(302);
	});
});

describe("password reset", () => {
	it("answers identically for known and unknown emails (no enumeration)", async () => {
		await registerUser("resetme@example.com");
		const known = await call("/forgot-password", {
			method: "POST",
			headers: xhr,
			body: { email: "resetme@example.com" },
		});
		const unknown = await call("/forgot-password", {
			method: "POST",
			headers: xhr,
			body: { email: "ghost@example.com" },
		});
		expect(known.status).toBe(200);
		expect(unknown.status).toBe(200);
		expect((await page(known)).props.status).toBe("sent");
		expect((await page(unknown)).props.status).toBe("sent");
	});

	it("resets a password end to end (log mail driver)", async () => {
		await registerUser("resetflow@example.com");
		const { sentMails } = await import("../src/server/mailer");
		const before = sentMails.length;

		await call("/forgot-password", {
			method: "POST",
			headers: xhr,
			body: { email: "resetflow@example.com" },
		});
		const mail = sentMails[sentMails.length - 1]!;
		expect(sentMails.length).toBe(before + 1);
		expect(mail.subject).toBe("Reset your password");
		expect(mail.to).toBe("resetflow@example.com");

		const token = mail.text.match(/token=([0-9a-f]+)/)![1]!;
		expect(token).toBeTruthy();

		// wrong confirmation is rejected
		const badConfirm = await call("/reset-password", {
			method: "POST",
			headers: xhr,
			body: {
				email: "resetflow@example.com",
				token,
				password: "newpassword123",
				passwordConfirmation: "other",
			},
		});
		expect(badConfirm.status).toBe(422);
		expect((await page(badConfirm)).props.errors.password).toContain(
			"does not match",
		);

		const reset = await call("/reset-password", {
			method: "POST",
			headers: xhr,
			body: {
				email: "resetflow@example.com",
				token,
				password: "newpassword123",
				passwordConfirmation: "newpassword123",
			},
		});
		expect(reset.status).toBe(303);
		expect(
			new URL(reset.headers.get("location")!).searchParams.get("notice"),
		).toBe("password_reset");

		// old password no longer works, new one does
		const oldPw = await call("/login", {
			method: "POST",
			headers: xhr,
			body: { email: "resetflow@example.com", password: "password123" },
		});
		expect(oldPw.status).toBe(422);
		const newPw = await call("/login", {
			method: "POST",
			headers: xhr,
			body: { email: "resetflow@example.com", password: "newpassword123" },
		});
		expect(newPw.status).toBe(303);
	});

	it("rejects expired/invalid reset tokens", async () => {
		const res = await call("/reset-password", {
			method: "POST",
			headers: xhr,
			body: {
				email: "resetflow@example.com",
				token: "f".repeat(64),
				password: "newpassword123",
				passwordConfirmation: "newpassword123",
			},
		});
		expect(res.status).toBe(422);
		expect((await page(res)).props.errors.token).toContain(
			"invalid or has expired",
		);
	});
});

describe("infrastructure", () => {
	it("reports health", async () => {
		const res = await call("/health");
		expect(res.status).toBe(200);
		expect((await res.json()).status).toBe("ok");
	});

	// Static assets are served by the Workers Static Assets binding (env.ASSETS),
	// not by the Hono app — `run_worker_first = ["/*", "!/assets/*"]` bypasses
	// the Worker entirely for /assets/*. This cannot be tested via app.request()
	// without mocking the ASSETS fetcher binding. Skipped intentionally.
	it.skip("serves built asset files from /assets/*", async () => {
		const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
		mkdirSync("dist/assets", { recursive: true });
		const file = "dist/assets/__route_test__.css";
		writeFileSync(file, "body{}");
		try {
			const res = await call("/assets/__route_test__.css");
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
			expect(await res.text()).toBe("body{}");
		} finally {
			rmSync(file, { force: true });
		}
	});

	it("returns 400 when Google OAuth is not configured", async () => {
		const { config } = await import("../src/server/config");
		const savedId = config.google.clientId;
		const savedSecret = config.google.clientSecret;
		config.google.clientId = null;
		config.google.clientSecret = null;
		try {
			const res = await call("/auth/google");
			expect(res.status).toBe(400);
		} finally {
			config.google.clientId = savedId;
			config.google.clientSecret = savedSecret;
		}
	});

	it("redirects to Google when OAuth is configured", async () => {
		const { config } = await import("../src/server/config");
		const savedId = config.google.clientId;
		const savedSecret = config.google.clientSecret;
		config.google.clientId = "test-client-id";
		config.google.clientSecret = "test-client-secret";
		try {
			const res = await call("/auth/google");
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toContain("accounts.google.com");
		} finally {
			config.google.clientId = savedId;
			config.google.clientSecret = savedSecret;
		}
	});
});
