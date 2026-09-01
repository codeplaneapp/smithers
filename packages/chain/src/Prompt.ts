/**
 * The stable author-call prefix, assembled as a pure value.
 *
 * Sections are MDX sources (`prompts/*.mdx`) compiled into the generated
 * `internal/prompts.ts` this module imports and composes — no runtime
 * filesystem read, browser-safe, and a sync test fails the gate when the
 * sources and the generated module drift. Assembly is byte-stable — same
 * inputs, identical string — so the provider prompt-prefix cache hits
 * across turns. Design authority: `packages/chain/docs/contract.md`.
 *
 * The catalog block renders what the chain actually dispatches: names
 * dedupe last-wins exactly like `Catalog.make`'s lookup, an entry named
 * `author` is filtered (the trampoline intercepts that name before the
 * catalog), and names/descriptions are collapsed to single lines so no
 * entry can inject structure into the prefix. `forCatalog` assembles from
 * a mounted catalog service, keeping the advertised block and the
 * dispatched entries the same by construction.
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
 * The longest entry name the catalog block renders.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maxEntryName = 64

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
 * Collapses one declaration field to a single bounded line.
 *
 * Entry text is the least-trusted string in the prefix. Whitespace
 * collapsing defeats newline-based section forgery; stripping backticks and
 * a leading list or heading marker stops an entry from opening a code fence
 * or a rival section inside its own bullet; and the length cap bounds how
 * much of the prefix one entry can occupy. Truncation is marked so a
 * shortened line never reads as the whole declaration.
 */
const inline = (text: string, limit: number): string => {
  const flat = text.replaceAll(/\s+/g, " ").replaceAll("`", "").replace(/^[\s#>*+-]+/, "").trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`
}

/**
 * Renders the catalog as a byte-stable block: the author entry pinned
 * first, then every dispatchable entry sorted by name — deduped
 * last-wins to mirror `Catalog.make`, the reserved author name filtered,
 * and every line collapsed to one bounded line.
 *
 * @category assembly
 * @since 0.1.0
 * @slop
 */
export const catalogBlock = (entries: ReadonlyArray<Catalog.Entry>): string => {
  const dispatchable = new Map<string, Catalog.Entry>()
  for (const entry of entries) {
    if (entry.name === AuthorDeclaration.authorName) continue
    dispatchable.set(entry.name, entry)
  }
  // Names are unique after the dedupe, so the comparator never sees equals.
  const lines = [...dispatchable.values()]
    .sort((left, right) => left.name < right.name ? -1 : 1)
    .map((entry) => `- ${inline(entry.name, maxEntryName)} — ${inline(entry.description, maxEntryDescription)}`)
  return [
    "# Catalog",
    "",
    "The calls available to `ctx.call`:",
    "",
    `- ${AuthorDeclaration.authorName} — ${AuthorDeclaration.authorDescription}`,
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
