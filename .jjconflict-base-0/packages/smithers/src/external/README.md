# external/

Multi-language / external-process workflow support: `createExternalSmithers`
builds a `SmithersWorkflow` from a synchronous `buildFn` that returns a
`HostNodeJson` tree (the JSON mirror of what JSX rendering would produce)
instead of React elements.

- `serializeCtx` flattens a `SmithersCtx` into a JSON-safe `SerializedCtx` for
  the external process; `hostNodeToReact` converts the returned tree back into
  React elements, resolving string agent references against the `agents`
  registry (throws `UNKNOWN_AGENT` on a miss).
- `ExternalSmithersConfig.ts` / `HostNodeJson.ts` / `SerializedCtx.ts` are the
  type-only sidecars; `index.js` is the re-export entry the package root
  republishes as `createExternalSmithers`.

Gotcha: `createExternalSmithers` opens its own bun:sqlite DB (temp dir unless
`dbPath` is given) with the same WAL/busy_timeout PRAGMA recipe as `create.js`
and registers a process-exit close hook; call the returned `cleanup()` when
done.
