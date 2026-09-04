/** One row of the docs-site manifest. */
export interface DocsSiteEntry {
  /** The site directory under apps/docs/ and the subdomain under smithers.sh. */
  readonly slug: string
  /** The npm name of the documented package. */
  readonly name: string
  /** The source package directory relative to the repo root. */
  readonly dir: string
  /** The source package's package.json description. */
  readonly description: string
  /** The site title (the npm name). */
  readonly title: string
  /** The default deploy domain, `<slug>.smithers.sh`. */
  readonly domain: string
  /** The absolute path of the site directory. */
  readonly siteDir: string
  /** The environment variable overriding the deploy domain. */
  readonly envDomain: string
}

export declare const docsRoot: string
export declare const repoRoot: string
export declare const sites: ReadonlyArray<DocsSiteEntry>
export declare const bySlug: ReadonlyMap<string, DocsSiteEntry>
