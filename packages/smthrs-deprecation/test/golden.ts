/**
 * The wire text of the `smthrs` migration notice, and the Markdown
 * readers the tests use to find every copy of it.
 *
 * The notice is this package's entire product. Keeping the four lines here,
 * byte for byte, lets the tests compare every published copy against one
 * original.
 */

/** The notice `smthrs@1.0.0-rc.0` throws. */
export const notice: string = [
  "smthrs 1.0 is a migration notice, not a runtime.",
  "Smithers 1.0 ships as @smthrs/* packages. Install @smthrs/flows (authoring and engine)",
  "and @smthrs/cli (the `smthrs` command), then run `smthrs migrate` in a 0.x project.",
  "Migration guide: https://smithers.sh/migration/1.0"
].join("\n")

/** Every fenced block of a Markdown document, in order, with the fences removed. */
export const fences = (markdown: string): ReadonlyArray<string> =>
  [...markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => (match[1] ?? "").trimEnd())
