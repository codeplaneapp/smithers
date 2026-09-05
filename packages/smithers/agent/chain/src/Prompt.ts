/**
 * The stable author-call prefix, assembled as a pure value.
 *
 * Sections are MDX sources (`prompts/*.mdx`) compiled into the generated
 * `internal/prompts.ts` this module imports and composes — no runtime
 * filesystem read, browser-safe, and a sync test fails the gate when the
 * sources and the generated module drift. Assembly is byte-stable — same
 * inputs, identical string — so the provider prompt-prefix cache hits
 * across turns. Design authority: https://chain.smithers.sh/contract/.
 *
 * The catalog block renders what the chain actually dispatches: names
 * dedupe last-wins exactly like `Catalog.make`'s lookup, an entry named
 * `author` is filtered (the trampoline intercepts that name before the
 * catalog), names are advertised byte-identically or omitted, and
 * descriptions are collapsed to single lines so no entry can inject
 * structure into the prefix. `forCatalog` assembles from a mounted catalog
 * service, keeping the advertised block and the dispatched entries the same
 * by construction.
 *
 * @since 0.1.0
 */
import * as AuthorDeclaration from "./AuthorDeclaration.ts"
import type * as Catalog from "./Catalog.ts"
import * as sections from "./internal/prompts.ts"

/**
 * Which agent the prefix addresses: the concierge (closest to the user)
 * or a sub-agent.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Role = "concierge" | "sub"

/**
 * The BASE section: what the agent is and what a flow is.
 *
 * @category sections
 * @since 0.1.0
 * @slop
 */
export const base = sections.base

/**
 * The CONCIERGE section, added only for the concierge role.
 *
 * @category sections
 * @since 0.1.0
 * @slop
 */
export const concierge = sections.concierge

/**
 * The RULES section.
 *
 * @category sections
 * @since 0.1.0
 * @slop
 */
export const rules = sections.rules

/**
 * The authoring contract: what one turn's reply must contain.
 *
 * @category sections
 * @since 0.1.0
 * @slop
 */
export const contract = sections.contract

/**
 * The longest entry name the catalog block will advertise. An entry above
 * this bound is omitted rather than shortened, because advertised names must
 * stay byte-identical to what `Catalog.lookup` dispatches.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maxEntryName = 64

/** What every catalog line opens with, before the entry's name. */
const bullet = "- "

/**
 * What divides an entry's name from its description. It is the only
 * structure a catalog line has, so it is also what a reader splits on.
 */
const separator = " — "

/** One catalog line, and the only place its shape is written down. */
const line = (name: string, description: string): string => `${bullet}${name}${separator}${description}`

/**
 * Whether a name can be advertised verbatim on one bounded line.
 *
 * A name is rendered byte-identically or not at all, so the only names the
 * block can carry are the ones that already are one bounded line: no
 * whitespace to forge a section break, no backtick to open a span, and
 * within {@link maxEntryName}. Everything else is a name the model could
 * read but `Catalog.lookup` would refuse.
 *
 * The last clause is the round trip itself rather than a rule derived from
 * it: a reader recovers a call name by splitting a line at its FIRST
 * separator, so the name is renderable only when that first separator is the
 * real one. Deriving it from {@link line} keeps the predicate and the
 * renderer from drifting. The bullet contributes a space of its own, which
 * is what makes an entry named `—` — and only that one — render as
 * `- — — description`, whose first ` — ` sits before the name: a reader
 * splitting there recovers the empty string and calls something the catalog
 * does not carry. A name that merely CONTAINS an em dash, like `flows—build`,
 * still round-trips and is still advertised.
 *
 * @category assembly
 * @since 0.1.0
 * @slop
 */
export const renderableName = (name: string): boolean =>
  name.length > 0 && name.length <= maxEntryName && !/[\s`]/.test(name) &&
  line(name, "").indexOf(separator) === bullet.length + name.length

/**
 * The longest entry description the catalog block renders.
 *
 * Registry-discovered entries carry descriptions written in repository
 * files rather than by the harness, so one entry must not be able to claim
 * an unbounded share of the context window.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maxEntryDescription = 200

/**
 * Collapses one entry description to a single bounded line.
 *
 * Descriptions are the least-trusted strings in the prefix:
 * registry-discovered entries carry them from repository files. Three
 * defences, and deliberately no more. Whitespace collapsing defeats
 * newline-based section forgery, and it is what makes a `#` or a fence
 * harmless — both land mid-line, where they open nothing. Backticks come out
 * because a one-line description has no use for them. The length cap bounds
 * how much of the context window one entry can claim, and truncation is
 * marked so a shortened line never reads as the whole declaration.
 *
 * Names are treated differently: advertise-what-you-dispatch requires the
 * model to read the exact string `Catalog.lookup` accepts. An unrenderable
 * name is dropped because not advertising a dispatchable call is safe, while
 * advertising a rewritten call that gate 3 then refuses is not.
 */
const inlineDescription = (description: string, limit: number): string => {
  const flat = description.replaceAll(/\s+/g, " ").replaceAll("`", "").trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`
}

/**
 * Renders the catalog as a byte-stable block: the author entry pinned
 * first, then every dispatchable entry sorted by name — deduped
 * last-wins to mirror `Catalog.make`, the reserved author name filtered,
 * with names advertised verbatim or omitted and descriptions collapsed to
 * one bounded line.
 *
 * @category assembly
 * @since 0.1.0
 * @slop
 */
export const catalogBlock = (entries: ReadonlyArray<Catalog.Entry>): string => {
  const dispatchable = new Map<string, Catalog.Entry>()
  for (const entry of entries) {
    if (!renderableName(entry.name)) continue
    if (entry.name === AuthorDeclaration.authorName) continue
    dispatchable.set(entry.name, entry)
  }
  // Names are unique after the dedupe, so the comparator never sees equals.
  const lines = [...dispatchable.values()]
    .sort((left, right) => left.name < right.name ? -1 : 1)
    .map((entry) => line(entry.name, inlineDescription(entry.description, maxEntryDescription)))
  return [
    "# Catalog",
    "",
    "The calls available to `ctx.call`:",
    "",
    line(AuthorDeclaration.authorName, AuthorDeclaration.authorDescription),
    ...lines
  ].join("\n")
}

/**
 * What assembly needs: the role the prefix addresses and the entries the
 * catalog block advertises.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface AssembleOptions {
  readonly role: Role
  readonly entries: ReadonlyArray<Catalog.Entry>
}

/**
 * Assembles the full prefix in fixed order: BASE, CONCIERGE (concierge
 * role only), RULES, the authoring contract, the catalog block.
 *
 * @category assembly
 * @since 0.1.0
 * @slop
 */
export const assemble = (options: AssembleOptions): string =>
  [
    base,
    ...(options.role === "concierge" ? [concierge] : []),
    rules,
    contract,
    catalogBlock(options.entries)
  ].join("\n\n")

/**
 * Assembles the prefix from a mounted catalog service — the composition
 * that cannot diverge from what the chain dispatches.
 *
 * @category assembly
 * @since 0.1.0
 * @slop
 */
export const forCatalog = (catalog: Catalog.Service, role: Role): string => assemble({ entries: catalog.entries, role })
