/** Options for {@link deployDocsSite}. */
export interface DeployDocsSiteOptions {
  /** The site slug: the app name `smithers-docs-<slug>` and the default domain. */
  readonly slug: string
}

/**
 * Deploys one docs site's Cloudflare Website and finalizes the Alchemy app.
 * Resolves to the deployed Website resource.
 */
export declare function deployDocsSite(options: DeployDocsSiteOptions): Promise<unknown>
