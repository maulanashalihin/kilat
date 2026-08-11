# AGENTS.md

Guidelines for AI coding agents working on this repository. Read this before
writing, moving, or restructuring code. The README documents features in
depth; this file exists to keep new code structurally consistent — previous
contributions broke the architecture by inventing their own layout.

## Stack

- **Cloudflare Workers** — serverless runtime at the edge. Entry point is
  `src/worker.ts` (`export default { fetch }`). Wrangler is the dev/deploy
  tool (`wrangler dev`, `wrangler deploy`).
- **Bun >= 1.3** — package manager and script runner only (not the runtime).
  `bun install`, `bun run build`, `bun run test`. The app does NOT run on
  Bun; it runs on the Workers runtime via Wrangler/Miniflare.
- **Hono 4.x** (HTTP). Runtime-agnostic; `app.fetch(request, env)` is called
  per-request from the Worker fetch handler. Hono stores the 2nd fetch arg
  as `c.env` — same pattern as Bun.serve.
- **D1** (SQLite at the edge) — async, zero-ORM. Accessed via `env.DB`
  binding (`prepare().bind().first/all/run`). Schema lives in `migrations/`
  (versioned SQL applied via `wrangler d1 migrations apply`).
- **Inertia v3 + Svelte 5** — in-process SSR; page registry in
  `src/client/pages.ts` with explicit imports. SSR via `render` from
  `svelte/server` — pre-built to `dist/ssr.js` because Wrangler's internal
  esbuild cannot compile `.svelte` files.
- **esbuild** — client asset bundler (`scripts/build.ts`). Two esbuild
  passes: client (with `sveltePlugin("client")`) and SSR (with
  `sveltePlugin("server")` → `dist/ssr.js`). Emits content-hashed JS + CSS
  to `dist/`, served via Workers Static Assets binding (`env.ASSETS`).
- **Scoped `<style>` in `.svelte` SFCs** — no CSS framework. `styles.css`
  holds only global base (tokens, reset, shared UI primitives); component
  and page styles live in scoped `<style>` blocks inside each `.svelte`
  file (see "CSS" below).

## Layout

```
src/
├── worker.ts               # Cloudflare Workers entry: initConfig, initDb, app.fetch
├── server/
│   ├── app.ts              # composition: middleware order, onError, notFound, routes
│   ├── config.ts           # validated env config via initConfig(env) per-request
│   ├── db.ts               # D1 async query helpers (initDb pattern, prepare/bind/first/all/run)
│   ├── auth.ts             # PBKDF2 (Web Crypto), sessions, flash, cookies, guards
│   ├── inertia.ts          # Inertia v3 server adapter (framework-light)
│   ├── inertia-middleware.ts # per-request session resolve → c.var (AppEnv)
│   ├── validation.ts       # TypeBox JSON validation → ValidationFailed (422)
│   ├── mailer.ts           # mail drivers: log / resend / mailtrap
│   ├── rate-limit.ts       # no-op stub (stateless Workers — use KV/DO for real limiting)
│   ├── logger.ts           # per-request console.log + crypto.randomUUID for request ID
│   ├── security.ts         # CSRF origin check (headers via hono/secure-headers)
│   ├── url.ts              # defensive request-URL parsing
│   ├── assets.ts           # re-exports InertiaAssets type (serving via Static Assets binding)
│   └── routes/
│       ├── auth.routes.ts         # /login /register /logout /forgot-password /reset-password (GET+POST)
│       ├── google-oauth.routes.ts # /auth/google, /auth/google/callback
│       ├── pages.routes.ts        # app-shell pages: /, /dashboard, /admin
│       └── profile.routes.ts      # /profile page + /profile/avatar
├── client/                 # Svelte + Inertia (pages/, components/, styles.css = global base only)
├── shared/                 # types.ts, inertia.d.ts (client+server shared)
├── migrations/             # versioned SQL schema files (0001, 0002, …)
└── tests/                  # bun:test E2E suite
scripts/
├── build.ts                # esbuild: two passes — client bundle → dist/assets/app-[hash].js + CSS + manifest.json; SSR bundle → dist/ssr.js
├── svelte-plugin.ts        # esbuild plugin: compile .svelte components (client + server modes)
└── seed.ts                 # wrangler d1 execute kilat --local + hashPassword
wrangler.toml               # Workers config: D1 binding, ASSETS binding, nodejs_compat, env vars
dist/                       # build output (gitignored), served by Workers Static Assets
```

### `src/client/`

```
src/client/
├── app.ts              # Inertia client bootstrap (mount/hydrate)
├── ssr.ts              # in-process SSR renderer (svelte/server) — pre-built to dist/ssr.js
├── pages.ts            # explicit page registry (shared by SSR + bundle)
├── pages/              # Login, Register, Dashboard, ForgotPassword,
│                       # ResetPassword, Admin, NotFound, Profile (.svelte)
├── components/         # Layout, AuthLayout, Brand, Field (.svelte)
└── styles.css          # global base: tokens, reset, shared UI primitives
```

## Hard rules

1. **Routes live in `src/server/routes/<feature>.routes.ts`, handlers inline,
   one file per URL.** Route-specific handler logic stays in the route file
   (see `auth.routes.ts`); never create a `routes.ts` inside a feature
   folder. The feature name is derived from the URL, and every URL is
   defined in exactly one file — GET renders and POST actions live together
   (see "Route conventions" below).

2. **`src/server/` is flat except `routes/`. No feature subfolders.**
   Shared or transport-independent logic becomes a single flat module
   (`auth.ts`, `security.ts`, `mailer.ts`, `rate-limit.ts`). Extract a
   module only when logic is reused across routes or independent of Hono's
   context — not just to slim a file.

3. **All SQL lives in `db.ts`** as async query functions via the D1 binding.
   Schema changes are new numbered files `migrations/000N_*.sql`; never
   edit an applied migration. Apply with
   `wrangler d1 migrations apply kilat --local` (dev) or `--remote` (prod).
   Keep `db.ts` a single file — one coherent module reads better than a
   tree of small domain files; reconsider splitting by domain only past
   ~600–800 lines.

4. **Env is read per-request via `initConfig(env)`** in `config.ts`, called
   from the Worker fetch handler. Never read `process.env` in other modules
   — Workers does not expose it. Adding a config key means updating
   `config.ts`, `wrangler.toml` `[vars]`, and the README env table.

5. **Validation via TypeBox schemas** (`src/server/validation.ts`) at the
   route level; `app.onError` maps `ValidationFailed` to Inertia 422 page
   payloads (`VALIDATION_MESSAGES` in `auth.routes.ts`).

6. **TypeScript**: `strict` + `noUncheckedIndexedAccess` +
   `verbatimModuleSyntax` are on. Type-only imports MUST use `import type`.
   No ORM, no loose `any`; queries are parameterized. `bun run typecheck`
   runs `svelte-check --tsconfig ./tsconfig.json`.

7. **CSS is scoped, not centralised.** `styles.css` holds only global
   base: design tokens (`:root`, `[data-theme]`), reset (`*`, `body`, `h1`…),
   `:focus-visible`, and shared UI primitives used across multiple pages
   (`.btn`, `.badge`, `.panel`, `.table`, `.avatar`). Everything else lives
   in scoped `<style>` blocks inside each `.svelte` SFC. Never add
   page-specific or component-specific rules to `styles.css`. The Svelte
   compiler handles scoped `<style>` blocks; esbuild's `.css` loader bundles
   `styles.css` and any standalone `.css` imports.

8. **UI work follows the design system — never invents a parallel one.**
   Reuse tokens from `styles.css` and existing components; don't reach for
   AI-default aesthetics (beige, ghost cards, purple gradients, italic
   serif accents). New components add scoped `<style>` blocks per rule 7.
   Forms use `useForm` + `<form>` from `@inertiajs/svelte` — see
   `.llm-wiki/wiki/concepts/concept-inertia-form-patterns.md` for the
   decision rule and examples.

## Route conventions

- **File = URL namespace.** `/posts*` routes live in `routes/posts.routes.ts`
  with page renders and form actions together. Given a URL, the file name
  follows from its first segment — that is the discoverability contract.
- **`pages.routes.ts` is the app shell only** (/, /dashboard, /admin). New
  feature pages do not go there.
- **Infra endpoints** (`/health`) stay in `app.ts`, not route files.
- **Exports**: `const <feature>Routes = () => new Hono<AppEnv>()...`, mounted
  via `app.route('/', <feature>Routes())` in `app.ts`. Route factories take
  no arguments — the Inertia adapter is a global middleware on the app, not
  per-route state.

## Workers integration notes (do not "fix")

- **All DB calls are async.** D1 is async — `await env.DB.prepare(sql).bind(...).first()`.
  This cascades to all route handlers, auth functions, and middleware. Never
  use sync DB patterns.
- **`initConfig(env)` + `initDb(env.DB)` run per-request** in the fetch
  handler (`src/worker.ts`). They mutate module-level singletons — cheap
  pointer assignments. Do not cache state across requests; Workers
  isolates are stateless.
- **`Response.redirect()` returns immutable headers on Workers.** Hono's
  `secureHeaders` middleware crashes trying to append security headers to a
  frozen Response. Use `new Response(null, { status, headers: { location } })`
  instead — see `inertia.ts`, `auth.ts`, `google-oauth.routes.ts`.
- **No custom compression middleware.** Wrangler/Miniflare auto-compresses
  responses with gzip/br natively. Adding a custom compress middleware
  causes double-compression (gzip-on-gzip).
- **PBKDF2 is capped at 100K iterations on Workers.** The OWASP-recommended
  600K throws `NotSupportedError`. 100K is still OWASP-acceptable for
  PBKDF2-HMAC-SHA256.
- **`node:crypto` is not available.** Use Web Crypto API (`crypto.subtle`,
  `crypto.getRandomValues`, `crypto.randomUUID`). `nodejs_compat` flag is
  set in `wrangler.toml` but prefer Web Crypto for crypto operations.
- **Middleware runs in registration order**; global `app.use()` middleware
  must precede the routes they cover.
- **Middleware/guards MUST call `next()`** to continue the chain — returning
  `undefined` without `next()` errors with "Context is not finalized".
- **`c.header()`-queued headers are dropped** when a handler returns a
  custom `Response` — cookie helpers append to `c.res.headers` instead.
- **`@sinclair/typebox` does not pre-register string formats** — `email` is
  registered in `validation.ts`; add others there.
- **Static assets are served via Workers Static Assets binding** (`env.ASSETS`),
  not a custom handler. `run_worker_first = ["/*", "!/assets/*"]` in
  `wrangler.toml` means all requests hit the Worker first except `/assets/*`
  which bypass to the static asset binding directly.
- **SSR bundle is pre-built.** Wrangler's internal esbuild cannot compile
  `.svelte` files or resolve the `svelte` export condition.
  `scripts/build.ts` does a second esbuild pass (with `sveltePlugin("server")`)
  to produce `dist/ssr.js` — plain JS that Wrangler can bundle. `inertia.ts`
  imports `renderPage` from `../../dist/ssr.js`.
- **`@inertiajs/svelte` only exports under the `svelte` condition.** Bun.build
  can resolve this via `conditions: ['svelte']`, but the Bun runtime cannot.
  This is why the SSR bundle is pre-built.

## Testing

- Run **`bun test --isolate`** (or `bun run test`). NEVER plain `bun test`:
  bun 1.3 runs all test files in one shared process, but each suite sets its
  env in `beforeAll` and calls cleanup in `afterAll` as if process-
  isolated. Without `--isolate`, one file's teardown finalizes the next
  file's cached values.
- Suite must stay green: run `bun run typecheck` and
  `bun run test` before finishing. `bun run typecheck` runs
  `svelte-check --tsconfig ./tsconfig.json`; `tsc` is not used for
  typechecking in the Svelte variant.
- Tests use `bun:test` against the Hono app directly (not the Workers
  runtime). D1 calls need mocking or a local D1 instance via Miniflare.

## Browser testing

- When testing in the browser, ALWAYS open the browser console (DevTools →
  Console) and check for errors/warnings. Client-side runtime errors
  (failed imports, Svelte runtime errors, hydration mismatches, bad Inertia
  props, network 4xx/5xx on XHR) do NOT show up in `bun run typecheck` or
  the build — the build compiles, the page renders, and the bug is silent
  until you read the console. A green build + green tests does NOT mean the
  page works; the console is the source of truth for client-side failures.
- Use the `browser` tool (`xd://browser`) to drive a real tab and read
  `console` output, or screenshot DevTools. Do not declare a UI change
  verified without having read the console for the page you changed.

## Style

- Match the repo's current style: 2-space indent, double quotes, semicolons
  (normalized by the editor/agent formatter; `tests/` and the route files are
  the reference). When editing an existing file, match that file's
  formatting.
- Keep changes minimal and conventional; delete dead code rather than
  leaving shims or aliases behind a rename.
