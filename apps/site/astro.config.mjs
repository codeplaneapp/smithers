// @ts-check
import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"

/**
 * smithers.sh: the landing page at `/` (src/pages/index.astro), the downloads
 * page at `/download`, and the Starlight documentation at `/docs/**`.
 *
 * Starlight content is authored under src/content/docs/docs/ so every route
 * carries the /docs prefix and the root stays a plain Astro page. Add a page
 * there and list it in the sidebar below.
 */
export default defineConfig({
  site: "https://smithers.sh",
  output: "static",
  integrations: [
    starlight({
      title: "Smithers",
      disable404Route: true,
      description:
        "Smithers is an Effect-based durable-execution engine: typed flows that replay from a journal, content-addressed action results, capability-checked host access, read-only sync, and time travel over run history.",
      logo: { src: "./src/docs-assets/logo.png", alt: "Smithers" },
      favicon: "/favicon.png",
      customCss: ["./src/styles/starlight.css"],
      // Inter and IBM Plex Mono are the product UI's pairing. They come from
      // Google Fonts rather than an npm package so the docs add no dependency,
      // and src/styles/starlight.css names a system stack behind each one.
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true } },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href:
              "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          }
        }
      ],
      expressiveCode: {
        styleOverrides: {
          codeFontFamily: "\"IBM Plex Mono\", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        }
      },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/smithersai/smithers" }
      ],
      editLink: { baseUrl: "https://github.com/smithersai/smithers/edit/main/apps/site/src/content/docs/" },
      // Every group below autogenerates from a directory under
      // src/content/docs/docs/, so a new page appears as soon as it lands.
      // Order inside a group comes from `sidebar.order` in the page's
      // frontmatter, then the title. Only the root pages are listed by hand.
      sidebar: [
        {
          label: "Get started",
          items: [
            { label: "Overview", slug: "docs" },
            { slug: "docs/installation" },
            { slug: "docs/quickstart" }
          ]
        },
        { label: "Tutorials", autogenerate: { directory: "docs/tutorials" } },
        { label: "Guides", autogenerate: { directory: "docs/guides" } },
        { label: "Concepts", autogenerate: { directory: "docs/concepts" } },
        { label: "Examples", autogenerate: { directory: "docs/examples" }, collapsed: true },
        {
          label: "Reference",
          collapsed: true,
          items: [
            { slug: "docs/reference/cli", label: "CLI overview" },
            { label: "CLI verbs", autogenerate: { directory: "docs/reference/cli" }, collapsed: true },
            { slug: "docs/reference/flow-mdx" },
            { slug: "docs/reference/project-layout" },
            { slug: "docs/reference/environment-variables" },
            { slug: "docs/reference/errors" },
            { slug: "docs/reference/mcp-tools" },
            { slug: "docs/reference/http-api" },
            { label: "Packages", autogenerate: { directory: "docs/reference/api" }, collapsed: true },
            { label: "Build rules", autogenerate: { directory: "docs/reference/targets" }, collapsed: true },
            { slug: "docs/reference/glossary" }
          ]
        },
        { label: "Troubleshooting", autogenerate: { directory: "docs/troubleshooting" }, collapsed: true },
        { label: "Migration", autogenerate: { directory: "docs/migration" }, collapsed: true },
        { label: "Changelogs", autogenerate: { directory: "changelogs" }, collapsed: true }
      ]
    })
  ]
})
