/**
 * The frozen wire text of the `smthrs` migration notice, and the Markdown
 * readers the tests use to find every copy of it.
 *
 * The notice is this package's entire product. `docs/migration/rc-contract.md`
 * section 3.3 quotes it verbatim, so a reworded or rewrapped copy is a
 * different contract. Keeping the four lines here, byte for byte, is what lets
 * the tests compare every place the text is published against one original.
 */

/** The notice `smthrs@1.0.0-rc.0` throws, exactly as contract section 3.3 freezes it. */
export const notice: string = [
  "smthrs 1.0 is a migration notice, not a runtime.",
  "Smithers 1.0 ships as @smthrs/* packages. Install @smthrs/flows (authoring and engine)",
  "and @smthrs/cli (the `smithers` command), then run `smithers migrate` in a 0.x project.",
  "Migration guide: https://smithers.sh/migration/1.0"
].join("\n")

/** Every fenced block of a Markdown document, in order, with the fences removed. */
export const fences = (markdown: string): ReadonlyArray<string> =>
  [...markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => (match[1] ?? "").trimEnd())

/**
 * The body of one Markdown section: everything from `heading` up to the next
 * heading of the same level or higher.
 */
export const section = (markdown: string, heading: string): string => {
  const start = markdown.indexOf(heading)
  if (start < 0) throw new Error(`no section titled ${heading}`)
  const level = (/^#+/.exec(heading)?.[0] ?? "#").length
  const rest = markdown.slice(start + heading.length)
  const next = new RegExp(`^#{1,${level}} `, "m").exec(rest)
  return rest.slice(0, next?.index ?? rest.length)
}
