/**
 * Client entry. Bootstraps Inertia v3 + React 19.
 * When the page was server-rendered (data-server-rendered attribute) we
 * hydrate; otherwise we do a plain client render.
 */
import { createInertiaApp } from "@inertiajs/react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { notFoundPage, pages } from "./pages";
import "./.tailwind.css"; // Tailwind output (preflight + utilities)
import "./styles.css"; // custom CSS (overrides Tailwind via cascade)

const resolve = (name: string) =>
	pages[`./pages/${name}.tsx`]?.default ?? notFoundPage!;

createInertiaApp({
	id: "app",
	resolve,
	// React Strict Mode (dev-only, no-op in production): catches unsafe
	// lifecycles, double-render bugs, and legacy context API usage.
	strictMode: true,
	setup({ el, App, props }) {
		if (!el) return;
		const element = <App {...props} />;
		if (el.hasAttribute("data-server-rendered")) {
			hydrateRoot(el, element);
		} else {
			createRoot(el).render(element);
		}
	},
	title: (title: string) =>
		title ? `${title} — Kilat` : "Kilat",
	progress: { color: "#059669" },
});
