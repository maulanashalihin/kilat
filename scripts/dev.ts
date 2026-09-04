/**
 * Dev server lifecycle manager for AI agents.
 *
 *   bun run dev:background        — start `wrangler dev` detached, write lock file
 *   bun run dev:status            — check if server is running (PID, port, URL)
 *   bun run dev:stop              — graceful shutdown + remove lock file
 *   bun run dev:logs [--follow]   — view logs (tail -f style with --follow)
 *
 * Lock file: .kilat/dev.json ({ pid, port, url, startedAt })
 * Log file:  .kilat/dev.log
 *
 * Human developers: use `bun run dev` (foreground) instead.
 * Wrangler dev does not watch for file changes — run `bun run build` after
 * editing client code, then `bun run dev:restart` to pick up changes.
 */
import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";

const LOCK_FILE = ".kilat/dev.json";
const LOG_FILE = ".kilat/dev.log";
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_MS = 200;
const GRACEFUL_SHUTDOWN_MS = 5_000;
const DEFAULT_PORT = 8787;

interface LockFile {
	pid: number;
	port: number;
	url: string;
	startedAt: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function readLock(): LockFile | null {
	if (!existsSync(LOCK_FILE)) return null;
	try {
		return JSON.parse(readFileSync(LOCK_FILE, "utf-8")) as LockFile;
	} catch {
		return null;
	}
}

function removeLock(): void {
	if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function background(): Promise<void> {
	mkdirSync(".kilat", { recursive: true });

	const existing = readLock();
	if (existing && isProcessAlive(existing.pid)) {
		console.log(
			`Server already running at ${existing.url} (pid ${existing.pid})`,
		);
		console.log("Run `bun run dev:stop` to stop it first.");
		return;
	}
	if (existing) removeLock();

	// Build assets first if dist/manifest.json is missing
	if (!existsSync("dist/manifest.json")) {
		console.log("Building client assets...");
		const buildResult = spawn("bun", ["run", "build"], {
			stdio: "inherit",
			cwd: process.cwd(),
		});
		await new Promise<void>((resolve, reject) => {
			buildResult.on("exit", (code) =>
				code === 0 ? resolve() : reject(new Error(`Build failed (exit ${code})`)),
			);
			buildResult.on("error", reject);
		});
	}

	// Truncate log file, spawn child with stdout/stderr → log FD
	const fd = openSync(LOG_FILE, "w");
	const child = spawn("npx", ["wrangler", "dev", "--port", String(DEFAULT_PORT)], {
		stdio: ["ignore", fd, fd],
		detached: true,
		cwd: process.cwd(),
		env: process.env,
	});
	closeSync(fd);
	child.unref();

	const pid = child.pid;
	if (!pid) {
		console.error("Failed to spawn dev server.");
		process.exit(1);
	}

	// Poll log file for the readiness line that wrangler prints
	const start = Date.now();
	let url = "";
	let port = 0;

	while (Date.now() - start < READINESS_TIMEOUT_MS) {
		await sleep(READINESS_POLL_MS);
		if (!isProcessAlive(pid)) {
			console.error("Dev server exited unexpectedly. Logs:");
			try {
				console.error(readFileSync(LOG_FILE, "utf-8"));
			} catch {}
			removeLock();
			process.exit(1);
		}
		try {
			const log = readFileSync(LOG_FILE, "utf-8");
			const match = log.match(/http:\/\/localhost:(\d+)/);
			if (match) {
				port = parseInt(match[1]!, 10);
				url = `http://localhost:${port}`;
				break;
			}
		} catch {}
	}

	if (!url) {
		console.error("Dev server did not become ready within 30s. Logs:");
		try {
			console.error(readFileSync(LOG_FILE, "utf-8"));
		} catch {}
		process.exit(1);
	}

	writeFileSync(
		LOCK_FILE,
		JSON.stringify(
			{ pid, port, url, startedAt: new Date().toISOString() },
			null,
			2,
		),
	);
	console.log(`Server ready at ${url} (pid ${pid})`);
	console.log("Logs:  bun run dev:logs");
	console.log("Stop:  bun run dev:stop");
}

async function status(): Promise<void> {
	const lock = readLock();
	if (!lock) {
		console.log("No dev server running.");
		return;
	}
	if (!isProcessAlive(lock.pid)) {
		console.log("Dev server is not running (stale lock removed).");
		removeLock();
		return;
	}
	console.log(
		`Running: ${lock.url} (pid ${lock.pid}, started ${lock.startedAt})`,
	);
	try {
		const log = readFileSync(LOG_FILE, "utf-8");
		const lines = log.trim().split("\n").slice(-3);
		if (lines.length && lines[0]) {
			console.log("Recent logs:");
			for (const line of lines) console.log(`  ${line}`);
		}
	} catch {}
}

async function stop(): Promise<void> {
	const lock = readLock();
	if (!lock) {
		console.log("No dev server running.");
		return;
	}
	if (!isProcessAlive(lock.pid)) {
		console.log("Dev server was not running (stale lock removed).");
		removeLock();
		return;
	}
	try {
		process.kill(lock.pid, "SIGTERM");
	} catch {
		console.error(`Failed to send SIGTERM to pid ${lock.pid}.`);
		process.exit(1);
	}

	const start = Date.now();
	while (Date.now() - start < GRACEFUL_SHUTDOWN_MS) {
		await sleep(100);
		if (!isProcessAlive(lock.pid)) break;
	}

	if (isProcessAlive(lock.pid)) {
		console.log("Server did not stop gracefully, sending SIGKILL...");
		try {
			process.kill(lock.pid, "SIGKILL");
		} catch {}
	}

	removeLock();
	console.log("Dev server stopped.");
}

async function logs(follow: boolean): Promise<void> {
	if (!existsSync(LOG_FILE)) {
		console.log("No log file found. Is the server running?");
		return;
	}
	if (!follow) {
		const content = readFileSync(LOG_FILE, "utf-8");
		const lines = content.trim().split("\n").slice(-50);
		for (const line of lines) console.log(line);
		return;
	}

	// Follow mode — poll every 500ms for new content
	let lastSize = statSync(LOG_FILE).size;
	process.stdout.write(readFileSync(LOG_FILE, "utf-8"));
	process.on("SIGINT", () => process.exit(0));
	while (true) {
		await sleep(500);
		try {
			const size = statSync(LOG_FILE).size;
			if (size !== lastSize) {
				if (size < lastSize) {
					process.stdout.write(readFileSync(LOG_FILE, "utf-8"));
				} else {
					const all = readFileSync(LOG_FILE, "utf-8");
					process.stdout.write(all.slice(lastSize));
				}
				lastSize = size;
			}
		} catch {}
	}
}

// --- CLI ---

const subcommand = process.argv[2];
const flags = process.argv.slice(3);

switch (subcommand) {
	case "background":
		await background();
		break;
	case "status":
		await status();
		break;
	case "stop":
		await stop();
		break;
	case "logs":
		await logs(flags.includes("--follow") || flags.includes("-f"));
		break;
	default:
		console.log(`Usage: bun run scripts/dev.ts <command> [flags]

Commands:
  background         Start dev server in background (writes .kilat/dev.json)
  status             Check if dev server is running
  stop               Stop the background dev server
  logs [--follow]    View logs (tail -f with --follow)

Human developers: use \`bun run dev\` instead.`);
}
