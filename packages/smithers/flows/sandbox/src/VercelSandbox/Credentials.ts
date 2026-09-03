/**
 * Defines caller-supplied Vercel credentials.
 *
 * @since 0.1.0
 */

/**
 * Credential inputs accepted by the Vercel sandbox provider.
 *
 * An explicit OIDC token takes precedence over the caller-supplied
 * environment, and a personal token is used only with both identifiers.
 *
 * @category models
 * @since 0.1.0
 */
export interface Credentials {
  readonly oidcToken?: string | undefined
  readonly token?: string | undefined
  readonly teamId?: string | undefined
  readonly projectId?: string | undefined
}
