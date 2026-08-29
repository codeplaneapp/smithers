/**
 * The Vite plugin.
 *
 * It does two things. It regenerates `routes.gen.ts` and `routes.ui.gen.ts`
 * when the config resolves and whenever a routed file appears or disappears,
 * so the tables are never stale in dev. And it serves the brand declared in
 * `PACKAGE.ts` as two virtual modules: `virtual:smthrs-app/brand.css` for the
 * CSS custom properties, and `virtual:smthrs-app/manifest` for the shell.
 *
 * @since 0.1.0
 */
import type { Plugin } from "vite"
import type { AppManifest, Brand, BrandToken } from "./app.ts"
import { writeRoutes } from "./router.ts"

/**
 * The virtual module holding the brand as CSS custom properties.
 *
 * @category models
 * @since 0.1.0
 */
export const brandModuleId = "virtual:smthrs-app/brand.css"

/**
 * The virtual module holding the app manifest as JSON.
 *
 * @category models
 * @since 0.1.0
 */
export const manifestModuleId = "virtual:smthrs-app/manifest"

/**
 * Where each brand token lands in the `@smthrs/ui` styleguide vocabulary.
 *
 * `@smthrs/ui` components resolve their colors through the styleguide's custom
 * properties (`--bg`, `--text`, `--brand`, `--r-2`), so those are the names
 * that decide whether a component is styled. The `--house-*` aliases are
 * emitted for every token as well, so app CSS can read the brand by the same
 * vocabulary the author declared it in.
 */
const styleguide: Partial<Record<BrandToken, ReadonlyArray<string>>> = {
  primary: ["--inverse-bg", "--code-bg"],
  primarySubtle: ["--hover", "--code-text"],
  accent: ["--brand"],
  accentForeground: ["--inverse-text"],
  success: ["--success"],
  warning: ["--warning"],
  danger: ["--danger"],
  info: ["--info"],
  background: ["--bg"],
  surface: ["--surface-2", "--hover-subtle"],
  surfaceRaised: ["--surface", "--surface-3"],
  border: ["--border"],
  borderStrong: ["--border-strong", "--border-solid"],
  foreground: ["--text"],
  foregroundMuted: ["--text-muted"],
  foregroundSubtle: ["--text-faint", "--text-placeholder"],
  radiusSm: ["--r-1"],
  radiusMd: ["--r-2"],
  radiusLg: ["--r-3", "--r-bubble"],
  radiusXl: ["--r-4"],
  radiusPill: ["--r-full"],
  shadowSm: ["--shadow-1"],
  shadowMd: ["--shadow-2"],
  shadowLg: ["--shadow-3"]
}

const houseName = (token: string): string =>
  `--house-${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`

/**
 * Renders a brand as one CSS rule of custom properties.
 *
 * A token the brand did not declare is not emitted, so the styleguide default
 * survives. Google Fonts `@import` rules come first, because CSS ignores an
 * `@import` that follows a rule.
 *
 * @category constructors
 * @since 0.1.0
 */
export const brandCss = (brand: Brand): string => {
  const declarations: Array<string> = []
  for (const [token, value] of Object.entries(brand.tokens)) {
    declarations.push(`  ${houseName(token)}: ${value};`)
    for (const name of styleguide[token as BrandToken] ?? []) declarations.push(`  ${name}: ${value};`)
  }
  const fonts = brand.fonts ?? {}
  if (fonts.body !== undefined) declarations.push(`  --house-font-ui: ${fonts.body};`, `  --font-sans: ${fonts.body};`)
  if (fonts.mono !== undefined) {
    declarations.push(`  --house-font-mono: ${fonts.mono};`, `  --font-mono: ${fonts.mono};`)
  }
  if (fonts.display !== undefined) declarations.push(`  --house-font-display: ${fonts.display};`)
  if (fonts.wordmark !== undefined) declarations.push(`  --house-font-wordmark: ${fonts.wordmark};`)
  const imports = (fonts.googleFonts ?? [])
    .map((family) => `@import url("https://fonts.googleapis.com/css2?family=${family}&display=swap");`)
  return [...imports, ":root, [data-theme] {", ...declarations, "}", ""].join("\n")
}

/**
 * Loads an app's manifest by evaluating its `PACKAGE.ts` through `tsx`.
 *
 * The config process is not a TypeScript process, and `PACKAGE.ts` imports
 * `@smthrs/targets`, so the manifest cannot simply be imported. `tsx` is an
 * optional peer for exactly this reason: an app that passes
 * {@link CreateAppPluginOptions.manifest} never needs it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const loadManifest = async (root: string): Promise<AppManifest> => {
  const { tsImport } = await import("tsx/esm/api")
  const loaded = await tsImport(`${root}/PACKAGE.ts`, { parentURL: import.meta.url, tsconfig: false }) as {
    readonly App?: { readonly manifest?: AppManifest }
  }
  const manifest = loaded.App?.manifest
  if (manifest === undefined) {
    throw new Error(`${root}/PACKAGE.ts must export \`App\` from CreateApp({ ... })`)
  }
  return manifest
}

/**
 * What the plugin takes. Both fields have working defaults; an app normally
 * writes `createApp()`.
 *
 * @category models
 * @since 0.1.0
 */
export interface CreateAppPluginOptions {
  /** App root. Defaults to Vite's resolved root. */
  readonly root?: string
  /** Manifest loader. Defaults to {@link loadManifest} over `<root>/PACKAGE.ts`. */
  readonly manifest?: () => Promise<AppManifest>
}

/** The slice of `ViteDevServer` the plugin watches. */
interface WatchedServer {
  readonly watcher: {
    readonly on: (event: "add" | "unlink", listener: (file: string) => void) => unknown
  }
}

/**
 * The plugin, typed by what it actually uses rather than by Vite's full hook
 * signatures, so a host — or a test — can drive it directly.
 *
 * @category models
 * @since 0.1.0
 */
export interface CreateAppPlugin {
  readonly name: string
  readonly configResolved: (config: { readonly root: string }) => Promise<void>
  readonly configureServer: (server: WatchedServer) => void
  readonly resolveId: (id: string) => string | null
  readonly load: (id: string) => string | null
}

/** Whether a changed path is one the route tables are derived from. */
const isRouted = (file: string): boolean =>
  /\/(?:page|layout)\.tsx$/.test(file) || /\/panes\/[^/]+\.tsx$/.test(file) ||
  /\/flow\.(?:ts|mdx)$/.test(file) || /\/(?:AGENT|SANDBOX|TOOLS)\.ts$/.test(file)

/**
 * Creates the plugin.
 *
 * @example
 * ```ts
 * import { createApp } from "@smthrs/create-app/vite"
 * import react from "@vitejs/plugin-react"
 * import { defineConfig } from "vite"
 *
 * export default defineConfig({ plugins: [createApp(), react()] })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const createApp = (options: CreateAppPluginOptions = {}): CreateAppPlugin => {
  let root = options.root ?? process.cwd()
  let manifest: AppManifest | undefined
  const required = (): AppManifest => {
    if (manifest === undefined) throw new Error("smthrs-create-app: the manifest is read before configResolved ran")
    return manifest
  }
  // Only reached after `configResolved` settled the manifest, so the dirs are
  // the manifest's rather than the defaults.
  const regenerate = (): void => {
    writeRoutes({ root, dirs: required().dirs })
  }
  const plugin = {
    name: "smthrs-create-app",
    async configResolved(config: { readonly root: string }): Promise<void> {
      root = options.root ?? config.root
      manifest = await (options.manifest ?? (() => loadManifest(root)))()
      regenerate()
    },
    configureServer(server: WatchedServer): void {
      const onChange = (file: string): void => {
        if (isRouted(file)) regenerate()
      }
      server.watcher.on("add", onChange)
      server.watcher.on("unlink", onChange)
    },
    resolveId(id: string): string | null {
      return id === brandModuleId || id === manifestModuleId ? `\0${id}` : null
    },
    load(id: string): string | null {
      if (id === `\0${brandModuleId}`) return brandCss(required().brand)
      if (id === `\0${manifestModuleId}`) return `export default ${JSON.stringify(required())}`
      return null
    }
  } satisfies CreateAppPlugin & Plugin
  return plugin
}
