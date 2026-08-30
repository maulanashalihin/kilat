/**
 * Client entry. Bootstraps Inertia v3 + Svelte 5.
 * When the page was server-rendered (data-server-rendered attribute) we
 * hydrate; otherwise we do a plain client mount.
 */
import { createInertiaApp } from "@inertiajs/svelte";
import { mount, hydrate } from "svelte";
import { notFoundPage, pages } from "./pages";
import "./.tailwind.css"; // Tailwind output (preflight + utilities)
import "./styles.css"; // custom CSS (overrides Tailwind via cascade)

const resolve = (name: string) =>
	pages[`./pages/${name}.svelte`] ?? notFoundPage;

/** Read the CSP nonce from the <meta name="csp-nonce"> tag set by the server.
 *  Used by Inertia for inline styles (progress bar, error modal) so they
 *  pass a strict CSP without 'unsafe-inline'. */
const cspNonce =
	document.querySelector('meta[name="csp-nonce"]')?.getAttribute("content") ??
	undefined;

createInertiaApp({
	id: "app",
	resolve,
	nonce: cspNonce,
	setup({ el, App, props }) {
		if (!el) throw new Error("Root element #app not found");
		if (el.hasAttribute("data-server-rendered")) {
			hydrate(App, { target: el, props });
		} else {
			mount(App, { target: el, props });
		}
	},
	progress: { color: "#059669" },
});
