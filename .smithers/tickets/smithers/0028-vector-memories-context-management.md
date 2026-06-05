# Vector Memories for Cross-Session Context Management

> Target repo: **smithers**
> Surface: Studio 2 (agent-orchestrated chat) + `packages/memory`
> Reference: Contexa / Git Context Controller (see below)

## Problem

Studio 2 is a chat-first shell where **one conversation is the whole app** and a
cheap/fast router model dispatches every message to a "session" (see
`apps/smithers-studio-2/src/chat/README.md`). Many sessions and tags coexist.
Today the router and the orchestration agent have **no efficient way to recall
what was learned in other sessions**: cross-run memory is exact-match key/value
facts (`_smithers_memory_facts`, surfaced by `smithers memory list` and the
Studio 2 Memory surface), and message history is per-thread. There is no
semantic, query-driven retrieval across sessions/tags.

Consequences:

- The router routes blind. It cannot see "this user already debugged auth in
  session #3" when a new message arrives, so it mis-routes or spawns redundant
  sessions.
- The orchestration agent re-derives context the user already established
  elsewhere, burning tokens and producing inconsistent answers.
- Session-compaction decisions ("compact this, start fresh, or fork?") are made
  without knowing what's recoverable later, so we either over-keep context
  (cost) or drop recoverable context (quality).

We want **vector memories**: a background task embeds agent-authored memories so
the system can retrieve relevant context by similarity across sessions and tags,
cheaply, at routing time.

## Existing state (what we extend, not duplicate)

The repo already has the **bones** of this and they are currently dormant:

- `packages/db/src/internal-schema/smithersVectors.js` defines a
  `_smithers_vectors` table: `id, namespace, content, embedding BLOB,
  dimensions, metadata_json, document_id, chunk_index, created_at_ms`. The
  `CREATE TABLE` also lives in `packages/db/src/sql-message-storage.js`. **No
  code reads or writes this table** — no store, no service, no embed call.
- `packages/memory/src/SemanticRecallConfig.ts` is a type stub
  (`topK?`, `namespace?`, `similarityThreshold?`) referenced by
  `TaskMemoryConfig` but **never implemented**.
- The memory package's real surface today is exact key/value facts + threads +
  messages: `MemoryStore` / `MemoryServiceApi` (`getFact`/`setFact`/`listFacts`,
  thread + message CRUD). `smithers memory list <namespace>` reads facts via
  `createMemoryStore`.
- The chat README already anticipates a **"fast tagger agent writes tags
  server-side"** and per-message tags on `ChatItem.tags` — the natural author of
  memories to embed.

So this ticket **lights up `_smithers_vectors` + `SemanticRecallConfig`** as a
first-class part of `packages/memory`, rather than introducing a parallel store.

## How it works

1. **Authoring.** The orchestration agent (and the tagger) write memories the
   same way they write facts today — but memories flagged as semantically
   recallable are enqueued for embedding. A "memory" here is agent-authored
   text: a distilled fact, a session summary, a milestone — not raw transcript.
2. **Background embedding.** A background Smithers task (cron/workflow) drains
   the queue: for each pending memory it computes an embedding and upserts a row
   into `_smithers_vectors` (`content` = the text, `embedding` = the vector,
   `namespace`/`metadata_json` carrying session id + tags + source fact key).
   Embedding is **out of the hot path** so authoring stays fast.
3. **Retrieval.** A `semanticRecall(query, SemanticRecallConfig)` API embeds the
   query, scans candidate vectors (filtered by namespace/tags), ranks by cosine
   similarity, applies `similarityThreshold`, and returns the top-`topK`
   memories with their source metadata.
4. **Consumers.**
   - **Router model**: before routing a message, calls `semanticRecall` to find
     which existing sessions/tags are relevant, so it can route to an existing
     session instead of guessing.
   - **Orchestration agent**: pulls relevant cross-session memories into context
     for the current turn.
   - **Compaction**: when deciding compact / new-session / fork, the agent first
     embeds the about-to-be-dropped context so it stays recoverable, then
     compacts confidently.

## Reference: Contexa / Git Context Controller

The user cited "Contexto / CONTXTO." We could **not** find a project under that
exact spelling. The strongest match is **Contexa**, the reference implementation
of the **Git Context Controller (GCC)** paper (arXiv:2508.00031):

- Repo: https://github.com/swadhinbiswas/contexa
- Paper: https://arxiv.org/pdf/2508.00031

**Confidence: medium (~60%) on the name match, high on relevance.** It is the
closest-named open-source LLM **context-management/memory** project and its
ideas map cleanly onto our multi-session routing problem. (Adjacent projects
seen while searching: mem0, cognee, MemGPT, supermemory — all
embedding-+-vector-DB memory layers; mem0 defaults to OpenAI
`text-embedding-3-small`, a sane default for us too.)

What Contexa actually is: a **versioned, Git-inspired memory hierarchy** for
agents stored as human-readable Markdown/YAML in a `.GCC/` tree
(`main.md` roadmap → `branches/*/commit.md` milestone summaries →
`branches/*/log.md` Observation-Thought-Action traces). Four operations:
`COMMIT` (compress OTA steps into a milestone), `BRANCH` (isolated reasoning),
`MERGE` (integrate a branch), `CONTEXT(k)` (recall last *k* commits).

**Ideas worth borrowing (and their fit):**

- **Embed distilled milestones, not raw transcript.** Contexa's `COMMIT`
  compresses traces into a semantic summary before it becomes recallable
  context. We should embed agent-authored *memories/summaries*, not message
  spam — better signal, fewer vectors, lower cost. (This is the single most
  load-bearing borrow.)
- **`CONTEXT(k)` and the "K=1 wins" finding.** Their ablation shows recalling
  only the **most recent compressed commit** beats dumping full history. Our
  `topK` should default *small* (e.g. 3–5) and we should prefer recent +
  high-similarity over breadth — cheap router context, not a context flood.
- **Branch/merge as session lineage.** Their branches map onto our sessions/
  forks; carrying a "branch/session purpose + provenance" in `metadata_json`
  lets retrieval explain *why* a memory belongs to a session and lets the router
  reason about session relationships.
- **Human-readable provenance.** Contexa keeps everything inspectable. Our
  `_smithers_vectors.content` is already plain text; keep memories
  human-auditable in the Studio 2 Memory surface.

What we deliberately **don't** copy: Contexa stores no embeddings at all
(pure summary recall). We *do* need vectors because our recall is query-driven
across many sessions, not "last k commits of one trajectory."

## Proposed design for Smithers

**Where it lives:** `packages/memory` (extend), backed by the existing
`_smithers_vectors` table in `packages/db`. No new package, no parallel store.

### Storage

- Reuse `_smithers_vectors` (SQLite, per-workspace DB — same DB facts live in).
- Brute-force cosine over candidate rows is fine at expected scale (thousands of
  memories per workspace); pre-filter by `namespace`/tags in SQL, score in JS.
  Leave an explicit upgrade path to `sqlite-vec` (ANN index) behind the same
  API if a workspace's vector count grows — do **not** block v1 on it.
- A new `_smithers_vector_queue` (or a `pending` flag/column) tracks memories
  awaiting embedding so the background task is restart-safe and idempotent.

### Embedding provider

- Pluggable `EmbeddingProvider` seam (so no hard dependency / no mock in product
  code). Default to an AI-SDK embedding model (OpenAI `text-embedding-3-small`,
  1536 dims) consistent with the agents already wired in `packages/agents`.
- `dimensions` stored per-row so a model change doesn't corrupt recall (mismatched
  dims are skipped/re-embedded, not silently compared).

### API surface (in `packages/memory`)

Extend `MemoryStore` / `MemoryServiceApi`:

- `rememberVector(ns, content, metadata?)` — enqueue a memory for embedding
  (fast, no network).
- `embedPending(provider, limit?)` — background drain: embed + upsert; returns
  count. Called by the cron/workflow.
- `semanticRecall(query, config: SemanticRecallConfig)` — embed query, filter by
  `namespace`/tags, cosine-rank, threshold, return top-`topK` with metadata.
  This is the implementation `SemanticRecallConfig` has been waiting for.
- Effect variants (`*Effect`) to match the existing store convention.

### Background task

A Smithers workflow registered as a cron (reuse `smithers cron`) that calls
`embedPending` on an interval. Lives under the init-pack workflows so a workspace
opts in. Metrics via the existing observability counters pattern
(`memoryRecallQueries`, add `memoryVectorEmbeds`).

### Integration with the existing `smithers memory` model

- Facts stay the source of truth for **exact** lookups; vectors are an
  **additive recall index** over agent-authored text. A fact can opt into being
  embedded (its key/value becomes a memory) — no duplication of truth.
- `smithers memory` gains a `recall <query>` subcommand alongside `list`.
- The Studio 2 Memory surface (`apps/smithers-studio-2/src/memory/Memory.tsx`)
  gains a similarity-search mode reusing its existing debounced search box.

## Integration points with Studio 2

- **Router model context lookup** — the seam the chat README marks `SEAM:` for
  routing/tagging calls `semanticRecall` before dispatch; route to the
  best-matching existing session when similarity clears threshold.
- **Orchestration agent** — injects top-`topK` memories for the active turn,
  tagged with their source session so the agent can cite/cross-reference.
- **Compaction decisions** — `rememberVector` the to-be-dropped summary *before*
  compacting/forking, so compaction is reversible-in-spirit (recall it later)
  rather than lossy.
- **Tags** — the "fast tagger agent" (already planned) writes tags into the
  memory `metadata_json`; recall can be tag-scoped, matching the chat tag model.

## Acceptance criteria

- [ ] `packages/memory` exposes `rememberVector`, `embedPending`,
      `semanticRecall` (+ Effect variants) over `_smithers_vectors`.
- [ ] `SemanticRecallConfig` (`topK`, `namespace`, `similarityThreshold`) is
      honored by `semanticRecall`; default `topK` is small (3–5).
- [ ] Embedding runs in a background cron/workflow, off the authoring hot path;
      drain is idempotent and restart-safe (no double-embed).
- [ ] `EmbeddingProvider` is a DI seam (no module mocks); a real provider is the
      default, swappable in tests with a real deterministic stand-in.
- [ ] `smithers memory recall <query>` returns ranked memories with source
      metadata; `smithers memory list` unchanged.
- [ ] Studio 2 router seam can call recall and route to an existing session in a
      real e2e (seeded workspace, real backend — no `page.route` fabrication).
- [ ] Recall is namespace/tag-filterable and never compares mismatched
      `dimensions`.
- [ ] `pnpm typecheck` + `bun test` green for `packages/memory`; studio e2e green.

## Phased plan

1. **Phase 1 — store + recall (no agents).** Implement `rememberVector` /
   `embedPending` / `semanticRecall` over `_smithers_vectors` with the
   `EmbeddingProvider` seam; unit tests with a deterministic real provider.
   Wire `smithers memory recall`.
2. **Phase 2 — background embedding.** Init-pack cron workflow that drains the
   queue; metrics; restart-safety test.
3. **Phase 3 — router integration.** Hook the Studio 2 routing/tagging seam to
   `semanticRecall`; route-to-existing-session; real e2e.
4. **Phase 4 — orchestration + compaction.** Inject recalled memories into the
   agent turn; `rememberVector`-before-compact; Memory-surface similarity search.
5. **Phase 5 (optional) — scale.** `sqlite-vec` ANN index behind the same API if
   vector counts warrant it.

## Open questions

- **Name check.** Is "Contexto/CONTXTO" actually Contexa, or a different project
  the user has in mind (mem0 / cognee / supermemory all fit the description)?
  Confirm before leaning hard on Contexa specifics. (~60% confidence.)
- **What gets embedded automatically?** Every agent-authored fact, or only ones
  explicitly flagged? Auto-embedding everything risks noise (Contexa's lesson:
  embed *distilled* memories).
- **Embedding model + cost.** `text-embedding-3-small` default — but is a local/
  offline embedder needed for air-gapped workspaces?
- **Recency vs. similarity weighting.** Contexa's "K=1 recent wins" suggests a
  recency boost on top of cosine — what blend?
- **Scope boundary.** Is recall per-workspace only, or cross-workspace (the DB is
  per-workspace today)?
- **Garbage collection.** Do vectors get TTL/decay like facts
  (`deleteExpiredFacts`), or are they kept until their source fact is deleted?
