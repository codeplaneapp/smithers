# @smthrs/memory — src

Persistent memory for Smithers runs: working-memory facts, conversation
threads, and messages, stored in the shared smithers SQLite DB (tables come
from `@smthrs/db/internal-schema` via `schema.js`).

Every file here is importable as `@smthrs/memory/<name>`
through the package.json `./*` export, so treat **all** files as public npm
surface — do not rename, move, or delete them.

Layout pattern:

- `.js` implementation + type-only `.ts` sidecar (`MemoryFact.ts`,
  `MemoryStore.ts`, ...). Blocks between `// @smithers-type-exports-begin`
  and `...-end` are tool-managed — never hand-edit them.
- `types.js`, `service.js`, `processors.js`, `metrics.js`, `schema.js` are
  stable subpath entry shims; `memoryFact*`/`memoryMessage*`/`memoryRecall*`
  are one-line metric re-exports from observability.
- `index.js` is the main barrel; `index.d.ts` is the generated dts bundle
  (do not edit).

Key pieces:

- `namespaceToString.js` / `parseNamespace.js` — mirrored encode/decode pair
  for `kind:id` namespace strings (escape ordering matters; see comments).
- The three processors (`TtlGarbageCollector`, `TokenLimiter`, `Summarizer`)
  each return `{ name, process, processEffect }` per `MemoryProcessor.ts`.
- `MemoryService.js` is the Effect Context tag; `createMemoryLayer.js` wires
  it over the store layer.
- Persistence itself lives in `store/` (see its README).
