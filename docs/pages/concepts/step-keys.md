---
description: "How a step key is computed, what goes into it, and why the engine owns that policy rather than the hashing library."
---

# Step keys and content addressing

`@smthrs/keys` only provides the generic `Key` transformation. `@smthrs/crypto` provides SHA-256. The engine owns the policy deciding what data is hashed.

For a sealed action with an `idempotencyKey`, the engine hashes:

```typescript
{
  kind: "cache",
  input: callerIdentity,
  environment: { layers, capabilities },
  boundary?: { readSet, writeSet, boundaryMode }
}
```

An object identity is caller-owned. A string identity is first combined with the action name and declared schemas. The engine always adds the complete cache environment and any filesystem boundary itself.

When no complete cache environment is provided, `kind` becomes `"run"` and the current run ID is included. This permits replay within that run without claiming the result is safe to reuse elsewhere.

A declaration may narrow how far its recorded result travels with the `CachePolicy` annotation from `@smthrs/flow/CacheEnvironment`, which `@smthrs/patterns`'s `WithCache` attaches for a plan-time declaration. Scope is key material: `shared` folds nothing and keeps the content address the engine already derived, `run` folds the run ID, and `flow` folds the executing flow's tag. A narrowed step therefore addresses a digest no sibling derives, rather than relying on a read-time filter a second reader could disagree with. The same annotation's `ttlMs` bounds the age of a row the engine serves. The verdict is journalled before it is acted on, under a producer identity naming the run, the step key, the decision, and the row's recorded provenance, never the process that took it, so a replay, including one driven by the engine that resumed the run under a different journal source, reads the recorded decision instead of re-judging the age against a fresh clock. Past the bound the engine also journals the row's age, evicts it, and dispatches again.

Compensable, irreversible, and keyless actions receive engine-private invocation keys containing the run ID, allocation scope, ordinal, and durability tier.

All values are canonicalized through [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) and hashed with injected Effect `Crypto`.
