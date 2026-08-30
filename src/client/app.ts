/**
 * Client entry. Bootstraps Inertia v3 + Vue 3.
 * When the page was server-rendered (data-server-rendered attribute) the app
 * is created with createSSRApp, whose mount() hydrates; otherwise a plain
 * client render.
 */
import { createInertiaApp } from "@inertiajs/vue3";
import type { DefineComponent } from "vue";
import { createApp, createSSRApp, h } from "vue";
import { notFoundPage, pages } from "./pages";
import "./.tailwind.css"; // Tailwind output (preflight + utilities)
import "./styles.css"; // custom CSS (overrides Tailwind via cascade)

/** Read the CSP nonce from the <meta name="csp-nonce"> tag set by the server.
 *  Used by Inertia for inline styles (progress bar, error modal) so they
 *  pass a strict CSP without 'unsafe-inline'. */
const cspNonce =
	document.querySelector('meta[name="csp-nonce"]')?.getAttribute("content") ??
	undefined;

createInertiaApp({
	id: "app",
	resolve: (name) =>
		(pages[`./pages/${name}.vue`]?.default ?? notFoundPage) as DefineComponent,
	nonce: cspNonce,
	setup({ el, App, props, plugin }) {
		const hydrate = el.hasAttribute("data-server-rendered");
		const app = (hydrate ? createSSRApp : createApp)({
			render: () => h(App, props),
		});
		app.use(plugin);
		app.mount(el);
		return app;
	},
	title: (title: string) =>
		title ? `${title} — Kilat` : "Kilat",
	progress: { color: "#059669" },
});
