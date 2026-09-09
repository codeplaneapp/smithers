---
title: "Runtime portability"
description: "One durable engine, with Effect services selected at the host boundary."
---

# Runtime portability is a required contract

Smithers flow definitions and domain services are Effect programs. They do not
select a JavaScript runtime, open a SQL connection, or spawn another runtime.
Node and Bun use the same engine, journal, migration sets, run store, step cache,
capability checks, and durable waits. Only the executable's host layers differ.

The shared `@smthrs/flows/Runtime` composition requires Effect `SqlClient`,
`Path`, `FileSystem`, `Crypto` and JJ services. It creates no SQL driver. The
existing Node composition and the Bun composition inject their matching SQL
adapter and host services. Both database adapters share the schema guard and
startup retry logic; stores use the existing `DurableWriter` transaction policy.

```ts
import * as BunRuntime from "@smthrs/flows/BunRuntime"
import { Effect } from "effect"

const application = program.pipe(
  Effect.provide(BunRuntime.layerHost({
    filename: ".flows/engine.db",
    workspaceRoot: ".",
    owner: { hostId: "workspace-host" }
  }, registeredFlows))
)
```

Use `NodeRuntime.layerHost` with the same flow definitions in a Node executable.
The outer executable runs the Effect and owns its scope. Closing that scope
closes database resources and releases durable work. `signals: []` leaves signal
handling with an embedding application. Node/Bun compatibility does not imply
that browser or edge durable execution has been implemented.

## Database ownership

Use the current flow execution identity and existing durable stores for coding
plans, checks, results, waits and recovery. A product-specific projection may
have its own migration namespace in the injected database when existing stores
do not represent it. It must not create a separate connection, job queue,
command ledger or lease system to repeat the engine's responsibilities.

The Node adapter requires Node's SQLite implementation. Under Bun, select
`@smthrs/database/bun/BunDatabase`; a wrong-driver refusal names that correction.
The durable engine itself has no Bun exclusion. Both drivers reject legacy
Smithers 0.x databases before adding tables.

## Evidence and regression contract

`test/NativeRuntimeParity.test.ts` launches separate real Node and Bun processes.
A flow executes a recorded action and parks on a durable deferred; the other
runtime opens the same database, completes the deferred and resumes the flow.
Reopening it in the first runtime must not repeat that action. Both directions
are exercised. This is native Bun execution, not running Node through a Bun
package-manager shim.

The existing Node tests continue to verify registration ordering, ownership,
process containment and signal cleanup. Bun-specific host and database contract
coverage must be expanded alongside behavior changes. A Node sidecar is not a
compatibility solution: when a supported runtime cannot run a flow, repair its
injected platform implementation and add a regression scenario here.

The shared confined filesystem also has a native Node/Bun regression for
concurrent macOS developer-tool launches. Apple's `/usr/bin/python3` entry point
can share a tool-shim inode with Git. Bun's file `realpath` returned the other
hard-link name during concurrent operations, causing Git to receive Python
arguments. The shared host resolves the interpreter's parent directory and
follows actual leaf symlinks while preserving a hard-linked executable's entry
name. Explicit configuration still uses `AtomicFileSystem.layerWith`; domain
flows do not choose interpreters. The same executable, workspace confinement,
isolated environment and process limits are enforced on Node and Bun.
