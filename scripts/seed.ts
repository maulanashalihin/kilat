/**
 * `bun run db:seed [email] [password] [role] [--remote]` — create a demo user.
 * Defaults: demo@example.com / password123 / user.
 * Example: bun run db:seed admin@example.com admin123 admin --remote
 *
 * Seeds the local or remote D1 database via wrangler d1 execute.
 * Password is hashed with PBKDF2 (Web Crypto) before inserting.
 */
import { hashPassword } from "../src/server/auth";
import { execSync } from "node:child_process";

const remote = process.argv.includes("--remote");
const target = remote ? "--remote" : "--local";
const email = process.argv[2] ?? "demo@example.com";
const password = process.argv[3] ?? "password123";
const role = (process.argv[4] ?? "user").toLowerCase();

if (role !== "user" && role !== "admin") {
  console.error('Role must be "user" or "admin".');
  process.exit(1);
}

// Check if user already exists.
const checkResult = execSync(
  `wrangler d1 execute kilat ${target} --command "SELECT id FROM users WHERE email = '${email.replace(/'/g, "''")}'" --json`,
  { encoding: "utf8" },
);
const existing = JSON.parse(checkResult);
if (existing.results?.[0]?.results?.length > 0) {
  console.log(`User ${email} already exists.`);
  process.exit(0);
}

const passwordHash = await hashPassword(password);
// Escape single quotes in the hash for SQL safety.
const safeHash = passwordHash.replace(/'/g, "''");
const safeName = "Demo User".replace(/'/g, "''");
const safeEmail = email.replace(/'/g, "''");

execSync(
  `wrangler d1 execute kilat ${target} --command "INSERT INTO users (name, email, password_hash, role) VALUES ('${safeName}', '${safeEmail}', '${safeHash}', '${role}')"`,
  { stdio: "inherit" },
);
console.log(`Seeded ${email} (password: ${password}, role: ${role}) ${remote ? "→ remote" : "→ local"}`);
