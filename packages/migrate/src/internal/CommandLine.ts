/**
 * Rendering a structured command as the one shell line every surface agrees
 * on: the prompt, the report, and the `proc:spawn` grant.
 *
 * `@smthrs/kernel/CommandLine.render` is the authority for the grant resource,
 * and the kernel is a flow-lane dependency the scan surface must never load
 * (`test/Dependencies.test.ts`). This module is the scan-side copy of the two
 * pure rules the kernel applies to an argv it spawns without a shell, and
 * `test/flow/DerivedCommands.test.ts` pins that the two renderers agree token
 * for token, so a grant written from here is the line the kernel checks.
 *
 * @since 0.1.0
 */

/** Tokens made only of these characters need no quoting in a POSIX shell. */
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * Quotes one token for a POSIX shell, leaving obviously safe tokens alone.
 * Identical to `@smthrs/kernel/CommandLine.quote`.
 *
 * @category rendering
 * @since 0.1.0
 */
export const quote = (token: string): string =>
  token !== "" && SAFE.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`

/**
 * Renders an executable and its literal arguments the way the kernel renders
 * a command it spawns with no shell: every token POSIX-quoted.
 *
 * @category rendering
 * @since 0.1.0
 */
export const renderArgv = (executable: string, args: ReadonlyArray<string>): string =>
  [executable, ...args].map(quote).join(" ")
