// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightBlog from "starlight-blog";
import mdx from "@astrojs/mdx";

// `site` is used for canonical URLs — set it to the production domain
// before deploying.
export default defineConfig({
  site: "https://kilatjs.pages.dev",
  integrations: [
    starlight({
      plugins: [
        starlightBlog({
          title: "Notes",
          postCount: 20,
          recentPostCount: 20,
          authors: {
            maulana: {
              name: "Maulana Shalihin",
              title: "Kilat author",
              url: "https://github.com/maulanashalihin",
            },
          },
        }),
      ],
      title: "Kilat",
      description:
        "Edge-native full-stack starter: Cloudflare Workers + Hono + D1 + Inertia v3, with React/Svelte/Vue templates (vanilla CSS or Tailwind).",
      favicon: "/favicon.svg",
      logo: {
        src: "./src/assets/logo.svg",
        alt: "Kilat logo",
        replacesTitle: false,
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/maulanashalihin/kilat",
        },
      ],
      customCss: ["./src/styles/custom.css"],
      components: {
        Head: "./src/components/Head.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Building with AI agents", slug: "getting-started/ai-agents" },
          ],
        },
        { label: "Philosophy", slug: "philosophy" },
        { label: "Kilat vs. other frameworks", slug: "comparisons" },
        {
          label: "Architecture",
          items: [
            { label: "Overview", slug: "architecture/overview" },
            { label: "Conventions", slug: "architecture/conventions" },
            {
              label: "Request lifecycle",
              slug: "architecture/request-lifecycle",
            },
            { label: "Rate limiting", slug: "architecture/rate-limiting" },
            { label: "File uploads", slug: "architecture/file-uploads" },
          ],
        },
        {
          label: "Auth",
          items: [
            { label: "Sessions & guards", slug: "auth/sessions-guards" },
            { label: "Google OAuth", slug: "auth/google-oauth" },
            { label: "Password reset", slug: "auth/password-reset" },
          ],
        },
        {
          label: "Deployment",
          items: [
            { label: "Overview", slug: "deployment" },
            { label: "Configuration", slug: "deployment/configuration" },
            { label: "Custom domain", slug: "deployment/custom-domain" },
          ],
        },
        {
          label: "Database",
          items: [
            { label: "Schema & migrations", slug: "database/schema-migrations" },
            { label: "Local development", slug: "database/local-development" },
          ],
        },
        { label: "Testing", slug: "testing" },
        {
          label: "Extending",
          items: [
            { label: "Adding a feature", slug: "extending/adding-a-feature" },
          ],
        },
        { label: "Troubleshooting", slug: "troubleshooting" },
        { label: "Contributing", slug: "contributing" },
      ],
    }),
    mdx(),
  ],
});
