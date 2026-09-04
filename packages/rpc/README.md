# @smthrs/rpc

Shared product contracts for the local host, browser, and server. Import individual modules such as `@smthrs/rpc/LocalApp`, `@smthrs/rpc/AppLinks`, and `@smthrs/rpc/TargetGraph`.

`LocalApp` defines the local HTTP and WebSocket payloads, route constants, repository and terminal sessions, and target execution records. Parse incoming data with its Zod schemas; the inferred types describe validated values. `TargetGraph` defines graph nodes, edges, run summaries, and traversal helpers. `AppLinks` defines the native download and handoff links without inventing a release URL when none is configured.

These are public product contracts even while the package is private. Preserve wire fields and route strings when changing implementation details. All exported declarations carry descriptions, `@since`, and `@category`.

Run `pnpm run check`, `pnpm run lint`, and `pnpm run test` here. Sources use the standard NodeNext configuration with unchecked indexed access enabled; an array or dictionary lookup must handle absence. Tests live in `test/` and run under Vitest, matching the other packages. `IndexAccess.types.ts` pins the compiler contract.
