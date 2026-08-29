/**
 * `brandCss` is the one place an app's design tokens become CSS, and it is
 * served as a virtual module, so a wrong custom-property name is invisible at
 * build time and shows up as an unstyled component.
 *
 * The plugin half is driven directly rather than through a Vite dev server: it
 * only reads `config.root` and `server.watcher`, so a real server would add
 * startup cost and hide nothing.
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { AppManifest, Brand } from "../src/app.ts"
import { brandCss, brandModuleId, createApp, loadManifest, manifestModuleId } from "../src/vite.ts"

const roots: Array<string> = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "smthrs-vite-"))
  roots.push(root)
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
  return root
}

const layers = {
  "AGENT.ts": "export const Agent = {}\n",
  "SANDBOX.ts": "export const Sandbox = {}\n",
  "TOOLS.ts": "export const Tools = {}\n"
}

const minimal: Brand = { name: "test", tokens: { accent: "#5288c2", background: "#ffffff" } }

const manifestOf = (brand: Brand): AppManifest => ({
  name: "test",
  brand,
  nav: [],
  dirs: { app: "app", flows: "flows", tools: "tools" },
  deploy: { cloudflare: { workerName: "w", domain: "d.example.com", config: "worker/wrangler.jsonc" } }
})

describe("brandCss", () => {
  it("maps tokens onto house custom properties", () => {
    const css = brandCss(minimal)
    expect(css).toContain("--house-accent: #5288c2;")
    expect(css).toContain("--house-background: #ffffff;")
  })

  it("maps tokens onto the styleguide properties the components read", () => {
    const css = brandCss(minimal)
    expect(css).toContain("--brand: #5288c2;")
    expect(css).toContain("--bg: #ffffff;")
  })

  it("scopes declarations to :root and [data-theme]", () => {
    const css = brandCss(minimal)
    expect(css).toContain(":root, [data-theme] {")
    expect(css.trimEnd().endsWith("}")).toBe(true)
  })

  it("emits nothing for tokens the brand did not set", () => {
    const css = brandCss(minimal)
    expect(css).not.toContain("--house-secondary")
    expect(css).not.toContain("--house-danger")
  })

  it("emits a token with no styleguide alias under its house name only", () => {
    const css = brandCss({ name: "t", tokens: { radiusComposer: "1.875rem" } })
    expect(css).toContain("--house-radius-composer: 1.875rem;")
    expect(css.split("\n").filter((line) => line.trim().startsWith("--"))).toHaveLength(1)
  })

  it("declares font stacks under the house font properties", () => {
    const css = brandCss({
      ...minimal,
      fonts: { body: "Geist, sans-serif", mono: "Geist Mono", display: "PT Serif", wordmark: "Source Serif 4" }
    })
    expect(css).toContain("--house-font-ui: Geist, sans-serif;")
    expect(css).toContain("--font-sans: Geist, sans-serif;")
    expect(css).toContain("--house-font-mono: Geist Mono;")
    expect(css).toContain("--font-mono: Geist Mono;")
    expect(css).toContain("--house-font-display: PT Serif;")
    expect(css).toContain("--house-font-wordmark: Source Serif 4;")
  })

  it("puts every Google Fonts @import ahead of the first rule", () => {
    const css = brandCss({ ...minimal, fonts: { googleFonts: ["Geist:wght@400", "PT+Serif:wght@700"] } })
    const lines = css.split("\n")
    expect(lines[0]).toBe("@import url(\"https://fonts.googleapis.com/css2?family=Geist:wght@400&display=swap\");")
    expect(lines[1]).toBe("@import url(\"https://fonts.googleapis.com/css2?family=PT+Serif:wght@700&display=swap\");")
    expect(lines.indexOf(":root, [data-theme] {")).toBe(2)
  })

  it("emits no @import when the brand names no Google fonts", () => {
    expect(brandCss(minimal)).not.toContain("@import")
  })

  it("emits a valid empty rule for a brand with no tokens", () => {
    expect(brandCss({ name: "bare", tokens: {} })).toBe(":root, [data-theme] {\n}\n")
  })
})

describe("loadManifest", () => {
  it("reads App.manifest out of PACKAGE.ts", async () => {
    const root = tree({
      "PACKAGE.ts": `export const App = { manifest: ${JSON.stringify(manifestOf(minimal))} }\n`
    })
    expect(await loadManifest(root)).toEqual(manifestOf(minimal))
  })

  it("refuses a PACKAGE.ts that exports no App", async () => {
    const root = tree({ "PACKAGE.ts": "export const Package = {}\n" })
    await expect(loadManifest(root)).rejects.toThrow("must export `App`")
  })
})

describe("createApp", () => {
  it("regenerates both route tables when the config resolves", async () => {
    const root = tree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const plugin = createApp({ manifest: async () => manifestOf(minimal) })
    await plugin.configResolved({ root })
    expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).toContain("app/page.tsx")
    expect(existsSync(join(root, "routes.gen.ts"))).toBe(true)
  })

  it("prefers an explicit root over Vite's", async () => {
    const root = tree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const elsewhere = tree(layers)
    const plugin = createApp({ root, manifest: async () => manifestOf(minimal) })
    await plugin.configResolved({ root: elsewhere })
    expect(existsSync(join(root, "routes.gen.ts"))).toBe(true)
    expect(existsSync(join(elsewhere, "routes.gen.ts"))).toBe(false)
  })

  it("loads the manifest from PACKAGE.ts when none is supplied", async () => {
    const root = tree({
      ...layers,
      "site/page.tsx": "export default () => null\n",
      "PACKAGE.ts": `export const App = { manifest: ${
        JSON.stringify({ ...manifestOf(minimal), dirs: { app: "site", flows: "flows", tools: "tools" } })
      } }\n`
    })
    const plugin = createApp()
    await plugin.configResolved({ root })
    // The manifest's own dirs decide what is routed, not the defaults.
    expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).toContain("site/page.tsx")
  })

  it("regenerates when a routed file appears and ignores anything else", async () => {
    const root = tree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const plugin = createApp({ root, manifest: async () => manifestOf(minimal) })
    await plugin.configResolved({ root })

    const listeners: Array<(file: string) => void> = []
    plugin.configureServer({ watcher: { on: (_event, listener) => listeners.push(listener) } })
    expect(listeners).toHaveLength(2)

    mkdirSync(join(root, "app/panes"), { recursive: true })
    writeFileSync(join(root, "app/panes/balances.tsx"), "export const Pane = {}\n")

    listeners[0]!(join(root, "src/theme.css"))
    expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).not.toContain("balances")

    listeners[0]!(join(root, "app/panes/balances.tsx"))
    expect(readFileSync(join(root, "routes.ui.gen.ts"), "utf8")).toContain("balances")
  })

  it("resolves only its own virtual modules", () => {
    const plugin = createApp()
    expect(plugin.resolveId(brandModuleId)).toBe(`\0${brandModuleId}`)
    expect(plugin.resolveId(manifestModuleId)).toBe(`\0${manifestModuleId}`)
    expect(plugin.resolveId("react")).toBeNull()
  })

  it("serves the brand and the manifest, and nothing else", async () => {
    const root = tree(layers)
    const plugin = createApp({ root, manifest: async () => manifestOf(minimal) })
    await plugin.configResolved({ root })
    expect(plugin.load(`\0${brandModuleId}`)).toContain("--house-accent: #5288c2;")
    expect(plugin.load(`\0${manifestModuleId}`)).toBe(`export default ${JSON.stringify(manifestOf(minimal))}`)
    expect(plugin.load("\0virtual:other")).toBeNull()
  })

  it("refuses to serve a virtual module before the config resolved", () => {
    const plugin = createApp()
    expect(() => plugin.load(`\0${brandModuleId}`)).toThrow("before configResolved ran")
  })
})
