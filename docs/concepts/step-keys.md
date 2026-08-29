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

Compensable, irreversible, and keyless actions receive engine-private invocation keys containing the run ID, allocation scope, ordinal, and durability tier.

All values are canonicalized through [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) and hashed with injected Effect `Crypto`.
