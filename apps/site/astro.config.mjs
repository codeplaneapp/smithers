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
      sidebar: [
        { label: "Get started", link: "/docs/" },
        { label: "Intro", link: "/docs/intro" }
      ]
    })
  ]
})
