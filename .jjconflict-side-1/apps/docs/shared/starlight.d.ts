import type starlightIntegration from "@astrojs/starlight"

/** Options for {@link defineDocsSite}, one per manifest row. */
export interface DocsSiteOptions {
  /**
   * The starlight integration, imported by the generated astro.config.mjs
   * itself and passed in: astro's config loader only compiles starlight's
   * raw .ts entry when the import comes from the config file.
   */
  readonly starlight: typeof starlightIntegration
  /** The site slug: its directory under apps/docs/ and its smithers.sh subdomain. */
  readonly slug: string
  /** The site title (the package's npm name). */
  readonly title: string
  /** The site description (the source package's package.json description). */
  readonly description: string
  /** The repo-relative source package directory, for the edit-link base. */
  readonly sourceDir: string
  /** The synced content root; defaults to ./src/content/docs under the cwd. */
  readonly contentDir?: string | undefined
}

/** The astro config for one package's docs site. */
export declare function defineDocsSite(options: DocsSiteOptions): {
  readonly site: string
  readonly output: string
  readonly integrations: unknown[]
}

/** The sidebar computed from a synced content tree. */
export declare function sidebarFor(contentRoot: string): unknown[]
