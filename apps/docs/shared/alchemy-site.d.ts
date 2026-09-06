import type * as Alchemy from "alchemy"

/** Options for a package site's declarative Alchemy 2 stack. */
export interface DocsSiteStackOptions {
  /** The app name is smithers-docs-<slug>; the default domain is <slug>.smithers.sh. */
  readonly slug: string
}

/** Returns an unevaluated stack. The Alchemy CLI owns plan, deploy, and destroy. */
export declare function makeDocsSiteStack(options: DocsSiteStackOptions): ReturnType<typeof Alchemy.Stack>
