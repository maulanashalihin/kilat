/**
 * Minimal, dependency-free Inertia v3 server adapter for Hono.
 * Implements the v3 wire protocol:
 *  - full HTML shell (with in-process React SSR) for browser visits
 *  - JSON page payloads for X-Inertia requests
 *  - 409 + X-Inertia-Location on asset version mismatch
 *  - partial reloads (X-Inertia-Partial-*)
 *  - shared props (auth) + flash + errors merged into every page
 *
 * The adapter is framework-light: it only needs the Request, the headers
 * (lowercase-keyed, as `Headers.entries()` yields), and the per-request
 * session slice. Response building is plain `Response` objects, so nothing
 * here is Hono-specific beyond the type names.
 */
import type { Page } from "@inertiajs/core";
import { renderPage } from "../../dist/ssr.js";
import type { FlashData, SharedPageProps } from "../shared/types";
import { config } from "./config";
import { clearFlash } from "./auth";

export interface InertiaAssets {
	/** Asset version used for cache busting + Inertia version negotiation. */
	version: string;
	/** Emitted JS entrypoint, relative to dist/, e.g. assets/app-abc123.js */
	js: string;
	/** Emitted stylesheet, relative to dist/, e.g. assets/app-abc123.css */
	css: string;
}

/** The slice of request context the adapter needs. */
export interface InertiaContext {
	request: Request;
	/** Lowercase-keyed request headers (as `Headers.entries()` yields). */
	headers: Record<string, string | undefined>;
	user: SharedPageProps["auth"]["user"];
	flash: FlashData;
	sessionToken: string | null;
	/** Per-request CSP nonce for inline scripts/styles. */
	cspNonce: string;
}

const splitList = (value: string | undefined): string[] | undefined =>
	value
		? value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: undefined;

export class Inertia {
	constructor(
		private c: InertiaContext,
		private assets: InertiaAssets,
	) {}

	/** True when the request came from the Inertia client (XHR). */
	get isXhr(): boolean {
		return this.c.headers["x-inertia"] === "true";
	}

	/** The request URL as the client sees it. On Cloudflare Workers, the
	 *  Worker runs at the edge after TLS termination, so request.url already
	 *  carries the correct scheme (https:// for HTTPS requests). No APP_URL
	 *  scheme correction is needed — that pattern only applies to origin
	 *  servers behind a TLS-terminating proxy. */
	private get requestUrl(): URL {
		try {
			return new URL(this.c.request.url);
		} catch {
			return new URL("http://localhost/");
		}
	}

	private get currentUrl(): string {
		const url = this.requestUrl;
		return url.pathname + url.search;
	}

	private get versionMatches(): boolean {
		const header = this.c.headers["x-inertia-version"];
		return !header || header === this.assets.version;
	}

	/** Build the v3 page payload for `component`, applying partial reloads. */
	page(
		component: string,
		props: Record<string, unknown> = {},
		errors?: Record<string, string>,
	): Page {
		let pageProps = props;
		if (this.c.headers["x-inertia-partial-component"] === component) {
			const only = splitList(this.c.headers["x-inertia-partial-data"]);
			const except = splitList(this.c.headers["x-inertia-partial-except"]);
			if (only) {
				pageProps = Object.fromEntries(
					Object.entries(props).filter(([k]) => only.includes(k)),
				);
			}
			if (except) {
				pageProps = Object.fromEntries(
					Object.entries(pageProps).filter(([k]) => !except.includes(k)),
				);
			}
		}
		const { errors: flashErrors, ...flash } = this.c.flash;
		return {
			component,
			props: {
				...pageProps,
				auth: { user: this.c.user },
				errors: errors ?? flashErrors ?? {},
			} as unknown as Page["props"], // core types `errors` as Errors & ErrorBag (intersection)
			url: this.currentUrl,
			version: this.assets.version,
			flash,
		} as Page;
	}

	/**
	 * Render a page: full HTML (SSR when enabled) for browser visits, JSON for
	 * Inertia XHR. When config.ssr is false, ships an empty shell with the page
	 * payload inlined as JSON so the client renders from scratch (no hydrate).
	 * SSR is also skipped for authenticated routes (this.c.user set): those
	 * pages are behind an auth wall (no SEO benefit) and the client hydrates
	 * and replaces server HTML anyway, so SSR is pure waste — ship the empty
	 * shell instead. Consumes the one-shot flash after building the payload.
	 */
	async render(
		component: string,
		props: Record<string, unknown> = {},
		options: { status?: number } = {},
	): Promise<Response> {
		const page = this.page(component, props);

		if (this.isXhr) {
			if (!this.versionMatches) return this.locationVisit();
			clearFlash(this.c.sessionToken);
			return this.json(page, options.status ?? 200);
		}

		let head: string[] = [];
		let body: string;
		if (config.ssr && !this.c.user) {
			const rendered = await renderPage(page);
			head = rendered.head;
			body = rendered.body;
		} else {
			body = this.clientBody(page);
		}
		clearFlash(this.c.sessionToken);
		return this.html(head, body, options.status ?? 200);
	}

	/**
	 * Non-SSR body: the Inertia v3 page payload inlined as JSON in a
	 * `<script data-page>` tag, plus an empty mount point. Mirrors the wire
	 * format `buildSSRBody` produces but omits `data-server-rendered` and the
	 * rendered HTML, so the client does a plain `createRoot` render.
	 */
	private clientBody(page: Page): string {
		const json = JSON.stringify(page).replace(/\//g, "\\/");
		return `<script data-page="app" type="application/json" nonce="${this.c.cspNonce}">${json}</script><div id="app"></div>`;
	}

	/** 422-style validation response, Inertia-aware. */
	error(
		component: string,
		errors: Record<string, string>,
		status = 422,
	): Response {
		if (this.isXhr) return this.json(this.page(component, {}, errors), status);
		return new Response(JSON.stringify({ errors }), {
			status,
			headers: { "content-type": "application/json" },
		});
	}

	/** 303 for redirect-after-write; 302 for plain navigation redirects.
	 *  Uses `new Response` instead of `Response.redirect()` because the
	 *  latter returns immutable headers on Workers — secureHeaders middleware
	 *  crashes trying to append security headers to a frozen Response. */
	redirect(path: string, status: 302 | 303 = 303): Response {
		return new Response(null, {
			status,
			headers: { location: new URL(path, this.requestUrl).toString() },
		});
	}

	// -- protocol internals ----------------------------------------------------

	private json(page: Page, status: number): Response {
		return new Response(JSON.stringify(page), {
			status,
			headers: {
				"content-type": "application/json; charset=utf-8",
				"x-inertia": "true",
				"x-inertia-version": this.assets.version,
			},
		});
	}

	/** 409 — client must full-reload: assets changed since it loaded. */
	private locationVisit(): Response {
		return new Response(null, {
			status: 409,
			headers: {
				"x-inertia-location": new URL(
					this.currentUrl,
					this.requestUrl,
				).toString(),
				"x-inertia-version": this.assets.version,
			},
		});
	}
	private html(head: string[], body: string, status: number): Response {
		const headTags = head.filter((h) => h && h.trim().length > 0);
		const hasTitle = headTags.some((h) => h.includes("<title"));
		const titleTag = hasTitle ? "" : "<title>Kilat</title>";
		const cssTag = this.assets.css
			? `<link rel="stylesheet" href="/assets/${this.assets.css}" />`
			: "";
		const favicon = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#059669"/><path d="M12 9h2.2c5.6 0 9.3 3.1 9.3 7s-3.7 7-9.3 7H12V9Z" fill="none" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><rect x="16" y="18.2" width="4.4" height="2.2" rx="1.1" fill="#059669"/></svg>',
		)}" />`;
		// Inline script: set data-theme + background-color on <html> before the
		// external stylesheet loads, so the page paints dark immediately (no FOUC).
		// Reads localStorage('theme'), falls back to prefers-color-scheme, defaults light.
		const themeBoot = `<script nonce="${this.c.cspNonce}">(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var el=document.documentElement;el.setAttribute('data-theme',t);el.style.backgroundColor=t==='dark'?'#0f1117':'#f6f7fb';}catch(e){document.documentElement.setAttribute('data-theme','light');}})();</script>`;
		const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="csp-nonce" content="${this.c.cspNonce}" />
${favicon}
${titleTag}
${headTags.join("\n")}
${themeBoot}
${cssTag}
</head>
<body>
${body}
<script type="module" src="/assets/${this.assets.js}"></script>
</body>
</html>`;
		return new Response(doc, {
			status,
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}
}
