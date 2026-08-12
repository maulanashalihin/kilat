/**
 * Client asset build for Cloudflare Workers.
 *
 * Replaces Bun.build with esbuild. Produces:
 *   dist/assets/app-[hash].js  — client bundle (React + Inertia)
 *   dist/assets/app-[hash].css — bundled stylesheet
 *   dist/manifest.json         — { version, js, css } for the Inertia adapter
 *
 * The asset version (content hash) doubles as the Inertia version for
 * cache-busting (409 on mismatch).
 *
 * Run: bun run scripts/build.ts  (or `bun run build`)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import esbuild from "esbuild";
import { $ } from "bun";

const DIST_DIR = "dist";
const ASSETS_DIR = join(DIST_DIR, "assets");
const MANIFEST_PATH = join(DIST_DIR, "manifest.json");

interface Manifest {
  version: string;
  js: string;
  css: string;
}

async function buildClientAssets(): Promise<void> {
  // Clean dist/ — stale hashed files would accumulate otherwise.
  if (existsSync(DIST_DIR)) rmSync(DIST_DIR, { recursive: true });
  mkdirSync(ASSETS_DIR, { recursive: true });

  // Compile Tailwind v4 → static CSS (no PostCSS needed).
  // Produces src/client/.tailwind.css which app.tsx imports.
  await $`bunx @tailwindcss/cli -i src/client/tailwind.css -o src/client/.tailwind.css --minify`.quiet();

  const result = await esbuild.build({
    entryPoints: ["src/client/app.tsx"],
    outdir: ASSETS_DIR,
    bundle: true,
    minify: true,
    sourcemap: false,
    splitting: false,
    format: "esm",
    target: "es2022",
    write: false, // we write manually to control the hash + manifest
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "css" },
  });

  // esbuild with write=false returns output files in memory.
  const jsFile = result.outputFiles.find((f) => f.path.endsWith(".js"));
  if (!jsFile) throw new Error("esbuild produced no JS output");

  const cssFile = result.outputFiles.find((f) => f.path.endsWith(".css"));

  // Content-hash the JS for cache busting.
  const jsHash = createHash("sha256")
    .update(jsFile.contents)
    .digest("hex")
    .slice(0, 16);
  const jsName = `app-${jsHash}.js`;
  writeFileSync(join(ASSETS_DIR, jsName), jsFile.contents);

  let cssName = "";
  if (cssFile) {
    const cssHash = createHash("sha256")
      .update(cssFile.contents)
      .digest("hex")
      .slice(0, 16);
    cssName = `app-${cssHash}.css`;
    writeFileSync(join(ASSETS_DIR, cssName), cssFile.contents);
  }

  // The version is the JS hash — Inertia uses it for 409 reload negotiation.
  const manifest: Manifest = {
    version: jsHash,
    js: jsName,
    css: cssName,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`Built client assets → dist/ (version ${manifest.version})`);
}

await buildClientAssets();
