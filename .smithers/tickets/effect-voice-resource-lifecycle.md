# Voice WebSocket and RAG pipeline resource management

## Problem

### Voice (`src/voice/realtime.ts`)

The `connect()` method creates a WebSocket, sets up EventEmitter listeners, and
stores the connection in a mutable `let ws`. If `connect()` throws after the
WebSocket is opened, the connection leaks. `speakerStreams` Map grows without
bound if `response.done` events are missed. No `Effect.acquireRelease` or `Scope`.

The `VoiceService` tag in `voice/effect.ts` wraps `VoiceProvider` without
`Layer.scoped` for connect/close lifecycle.

### RAG (`src/rag/pipeline.ts`)

Imperative ingest path loads all chunks into memory at once. No `Effect.Stream`
for backpressure or bounded concurrency on embedding API calls. Large document
sets will OOM.

### RAG VectorStore (`src/rag/vector-store.ts`)

Uses `fromSync` to wrap `Promise`-returning `VectorStore` methods. Works by
accident because Bun SQLite is synchronous. Will silently break with any async
VectorStore (Pinecone, Qdrant, etc.) — the Promise object becomes the "result"
instead of the resolved value.

## Proposed solution

1. Voice: Wrap WebSocket lifecycle in `Effect.acquireRelease` + `Layer.scoped`
2. Voice: Use `Effect.addFinalizer` for speaker stream cleanup
3. RAG: Convert ingest to `Effect.Stream` pipeline with `Stream.grouped` for
   batching and bounded concurrency on embeddings
4. RAG: Fix `fromSync` → `fromPromise` for VectorStore methods

## Severity

**MAJOR** — Resource leaks under error conditions and an interop bug that will
break with async vector stores.

## Files

- `src/voice/realtime.ts`
- `src/voice/effect.ts`
- `src/rag/pipeline.ts`
- `src/rag/vector-store.ts`
