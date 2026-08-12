/**
 * Page registry. Explicit imports work identically in the Bun server
 * runtime and the Bun.build client bundle (Bun 1.3 removed
 * `import.meta.glob`). Keys use the `./pages/<Name>.svelte` convention
 * that `resolve()` builds from the Inertia component name.
 */
import type { Component } from "svelte";
import Admin from "./pages/Admin.svelte";
import Dashboard from "./pages/Dashboard.svelte";
import ForgotPassword from "./pages/ForgotPassword.svelte";
import Login from "./pages/Login.svelte";
import NotFound from "./pages/NotFound.svelte";
import Profile from "./pages/Profile.svelte";
import Register from "./pages/Register.svelte";
import ResetPassword from "./pages/ResetPassword.svelte";

// Pages receive Inertia page props of varying shapes — widen deliberately.
// biome-ignore lint/suspicious/noExplicitAny: page props are heterogeneous
type PageModule = { default: Component<any> };

export const pages: Record<string, PageModule> = {
	"./pages/Admin.svelte": { default: Admin },
	"./pages/Dashboard.svelte": { default: Dashboard },
	"./pages/ForgotPassword.svelte": { default: ForgotPassword },
	"./pages/Login.svelte": { default: Login },
	"./pages/NotFound.svelte": { default: NotFound },
	"./pages/Profile.svelte": { default: Profile },
	"./pages/Register.svelte": { default: Register },
	"./pages/ResetPassword.svelte": { default: ResetPassword },
};

/** Fallback for unknown component names — never resolve to undefined. */
export const notFoundPage: PageModule = pages["./pages/NotFound.svelte"] ?? {
	default: NotFound,
};
