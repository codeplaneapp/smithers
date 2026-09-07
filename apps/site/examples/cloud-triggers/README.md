# Cloud trigger type contract

This is a declaration-only proof for documentation-driven development. It does
not implement trigger registration, matching, dispatch, or the `S.Automation`
runtime. The runtime APIs documented by these signatures still need to be built.

`contract.d.ts` models the recommended public surface. `typecheck.ts` uses the
workspace's real Effect schemas and checks inferred event unions, action and
custom-event narrowing, required flow payloads, completion outputs, and decoded
schema values. Every `@ts-expect-error` must correspond to a compiler error.

From the repository root:

```bash
node_modules/.bin/tsc -p apps/site/examples/cloud-triggers/tsconfig.json
```

The flow reference exposes the existing `payloadSchema`, `successSchema`, and
`_tag` fields. It models the schema relationship without importing a runtime or
launching work. Its input mapper matches the flow's `~type.make.in` type;
persisting that input requires schema encoding, rather than JSON-stringifying
decoded values such as `Date`.

Runtime verification remains necessary for cron and timezone validity, signature
verification, payload validation, predicate isolation, event deduplication,
revision pinning, and dispatch authorization. Passing this check proves only
the illustrated TypeScript relationships.
