import { Catalog } from "@smthrs/chain"
import { Effect } from "effect"
import type { AppStore } from "../state/AppStore"

/*
 * The worldview door (DESIGN.md §14, decision D2): remember and recall bound
 * to the worldDocuments wiki — the store that already matches the System
 * Prompt's worldview description (markdown, wikilinks, provenance,
 * confidence). recall is a scored keyword search (title ×3, tags ×2, body
 * ×1) that answers with each hit's confidence and freshness, never the whole
 * worldview; remember upserts a note with actor smithers and chain
 * provenance. The entry names and payload shapes are the stable contract —
 * when @smthrs/memory gains a browser store, it slots in underneath without
 * scripts changing. Free tier (app:act): writing its own memory is the
 * agent's core loop; the propose-only belief discipline arrives with the
 * belief lanes, not here.
 */

const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g

const tokensOf = (text: string): ReadonlyArray<string> => {
  const all = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
  // Prefer discriminating tokens, but never go blind: a query of only
  // short tokens ("jj", "ci") searches with what it has.
  const long = all.filter((token) => token.length > 2)
  return long.length > 0 ? long : all
}

const sanitizePath = (title: string): string =>
  `${title.replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, " ") || "Untitled"}.md`

export const worldviewEntries = (store: AppStore): ReadonlyArray<Catalog.Entry> => [
  {
    name: "recall",
    description:
      "Search the worldview wiki. Payload: { query: string, limit?: number }. Answers scored hits with path, title, snippet, confidence, and freshness — never the whole worldview.",
    capabilities: ["app:act"],
    handler: (payload) => {
      const record = typeof payload === "object" && payload !== null
        ? (payload as { readonly query?: unknown; readonly limit?: unknown })
        : {}
      if (typeof record.query !== "string" || record.query.trim() === "") {
        return Effect.fail(
          new Catalog.CallError({ name: "recall", message: `"recall" takes { query, limit? }` })
        )
      }
      const limit = typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0
        ? Math.min(record.limit, 10)
        : 5
      const needles = tokensOf(record.query)
      return Effect.sync(() => {
        const scored = [...store.collections.worldDocuments.values()]
          .map((document) => {
            const title = tokensOf(document.title)
            const tags = tokensOf(document.tags.join(" "))
            const body = tokensOf(document.body)
            let score = 0
            for (const needle of needles) {
              score += title.filter((token) => token === needle).length * 3
              score += tags.filter((token) => token === needle).length * 2
              score += body.filter((token) => token === needle).length
            }
            return { document, score }
          })
          .filter((hit) => hit.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, limit)
        return {
          results: scored.map(({ document, score }) => {
            const line = document.body
              .split("\n")
              .find((candidate) => needles.some((needle) => candidate.toLowerCase().includes(needle)))
            return {
              path: document.path,
              title: document.title,
              snippet: (line ?? document.body.split("\n")[0] ?? "").trim().slice(0, 200),
              confidence: document.confidence,
              updatedAt: document.updatedAt,
              score
            }
          })
        }
      })
    }
  },
  {
    name: "remember",
    description:
      "Write a worldview note. Payload: { title: string, text: string, path?: string, tags?: string[], confidence?: number }. Upserts by path; wikilinks in the text become links.",
    capabilities: ["app:act"],
    handler: (payload) => {
      const record = typeof payload === "object" && payload !== null
        ? (payload as {
          readonly title?: unknown
          readonly text?: unknown
          readonly path?: unknown
          readonly tags?: unknown
          readonly confidence?: unknown
        })
        : {}
      if (
        typeof record.title !== "string" ||
        record.title.trim() === "" ||
        typeof record.text !== "string" ||
        record.text.trim() === ""
      ) {
        return Effect.fail(
          new Catalog.CallError({
            name: "remember",
            message: `"remember" takes { title, text, path?, tags?, confidence? }`
          })
        )
      }
      const title = record.title.trim()
      const text = record.text
      const path = typeof record.path === "string" && record.path.trim() !== ""
        ? record.path.trim()
        : sanitizePath(title)
      return Effect.tryPromise({
        try: async () => {
          const existing = [...store.collections.worldDocuments.values()].find(
            (document) => document.path === path
          )
          // Omitted optional fields preserve the existing note's values; an
          // upsert only changes what the caller actually stated.
          const tags = Array.isArray(record.tags)
            ? record.tags.map((tag) => String(tag))
            : [...(existing?.tags ?? [])]
          const confidence = typeof record.confidence === "number" && record.confidence >= 0 && record.confidence <= 1
            ? record.confidence
            : (existing?.confidence ?? 0.6)
          const links = [...text.matchAll(WIKILINK)].map((match) => match[1] as string)
          // Nondeterministic id for a new note is fine: the settled call
          // journals the returned path/id, so replay never re-mints.
          const id = existing?.id ?? `world-${crypto.randomUUID()}`
          const sources = existing === undefined ? ["chain-remember"] : [...existing.sources]
          if (existing !== undefined && !sources.includes("chain-remember")) {
            sources.push("chain-remember")
          }
          await store.dispatch({
            type: "world.document.upserted",
            actor: "smithers",
            select: false,
            document: {
              id,
              path,
              title,
              body: text,
              links,
              tags,
              sources,
              confidence
            }
          }).isPersisted.promise
          return { id, path }
        },
        catch: (cause) =>
          new Catalog.CallError({
            name: "remember",
            message: `remember could not persist: ${cause instanceof Error ? cause.message : String(cause)}`
          })
      })
    }
  }
]
