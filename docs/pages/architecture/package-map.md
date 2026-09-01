---
description: "The package boundaries and the direction dependencies actually run between them."
---

# Package map

This page defines the repository’s package boundaries and actual workspace dependency direction. It is an architecture map, not an API reference; follow each package link for its exported types and functions.

An arrow means “depends on.” The one dotted edge is a test-only seam: `@smthrs/kernel`’s `test/TestHost` composes `@smthrs/platform-browser`’s in-tab `FileSystem` and `ChildProcessSpawner` to build its deterministic host, so the manifest edge exists in that direction too. No production module in `@smthrs/kernel` imports a platform bundle.

```mermaid
flowchart TD
  PN["@smthrs/platform-node"]
  PBUN["@smthrs/platform-bun"]
  JJ["@smthrs/jj"]
  SB["@smthrs/sandbox"]
  PB["@smthrs/platform-browser"]
  D["@smthrs/database"]
  C["@smthrs/canonical"]
  Crypto["@smthrs/crypto"]
  CAP["@smthrs/capability"]

  J["@smthrs/journal"] --> D
  RS["@smthrs/run-store"] --> D
  RS --> J
  SC["@smthrs/step-cache"] --> D
  A["@smthrs/artifacts"] --> Crypto
  PB --> JJ
  PB --> K
  PN --> JJ
  PN --> K
  PBUN --> JJ
  PBUN --> K
  SB --> K
  K["@smthrs/kernel"] --> CAP
  K --> JJ
  K --> J
  K -.test seam.-> PB
  JJ --> CAP
  F["@smthrs/flow"] --> Keys["@smthrs/keys"]
  F --> Crypto
  W["@smthrs/engine"] --> F
  W --> Keys
  Keys --> C
  Keys --> Crypto
  P["@smthrs/plan"] --> Keys
  P --> D
  P --> Crypto
  E["@smthrs/engine-store"] --> W
  E --> F
  E --> Crypto
  E --> D
  E --> J
  E --> RS
  E --> SC
  E --> A
  E --> K
  E --> P
  S["@smthrs/sync"] --> J
  T["@smthrs/time-travel"] --> D
  T --> E
  T --> JJ
  T --> J
  T --> RS
  T --> SC
```

| Package | Responsibility | Important boundary |
| --- | --- | --- |
| [`@smthrs/canonical`](/api/canonical) | RFC 8785 canonical JSON as an Effect Schema | Wraps the standards-focused `canonicalize` library |
| [`@smthrs/crypto`](/api/crypto) | Strict injected and synchronous SHA-256 | Effect Crypto supplies the injected path; the package owns the synchronous path |
| [`@smthrs/keys`](/api/keys) | Canonical flow keys | Composes `canonical` and `crypto` |
| [`@smthrs/database`](/api/database) | `SqlClient` access plus transactional SQLite write retry | Owns no domain tables |
| `@smthrs/platform-node`, `@smthrs/platform-bun` | The Node and Bun Host bundles: Effect's own platform services, filesystem, path, spawner, `HttpClient`, composed with the `Jj` adapter | Raw effects; no permission decisions. Bun composes `@effect/platform-bun` directly and does not depend on `@smthrs/platform-browser` |
| [`@smthrs/capability`](/api/capability) | The capability vocabulary, actions, patterns, tiers, and typed permission failures with their `PlatformError` projection | A leaf both the kernel and `@smthrs/jj` depend on; its schema ids stay `@smthrs/kernel/…` because they are journaled |
| [`@smthrs/jj`](/api/jj) | Jujutsu snapshot, restore, diff, and workspace operations | Depends on `effect` and `@smthrs/capability`; the closed Host list still names it |
| [`@smthrs/sandbox`](/api/sandbox) | A remote `ChildProcessSpawner` implementation and sandbox liveness | Adapts a caller's provider onto Effect's `ChildProcessSpawner`; owns no host access |
| [`@smthrs/platform-browser`](/api/platform-browser) | Browser implementations of effect's `FileSystem` and `ChildProcessSpawner`, and the `BrowserHost` bundle, which provides effect's own fetch-backed `HttpClient` | Depends on `effect`, `@smthrs/kernel`, and `@smthrs/jj` for the slots it fills; the ZenFS and just-bash backends are arguments, not dependencies |
| [`@smthrs/journal`](/api/journal) | The immutable event history: journal rows, projections, redaction, and the `OwnerId` fence its durable channel accepts | Open event envelope; owns `flows_journal_events` only |
| [`@smthrs/run-store`](/api/run-store) | Executable run state: run rows, attempt rows, and ownership arbitration | Owns `flows_runs` and `flows_attempts`; validates supplied liveness evidence, never probes |
| [`@smthrs/step-cache`](/api/step-cache) | Sealed step results addressed by step-key digest, plus the HTTP action-cache client and the local-first/remote-second composition | Owns `flows_step_cache`; depends on `database` alone |
| [`@smthrs/plan`](/api/plan) | The persisted plan: the `KeyMaterial`→`StepKey` compiler, `Plan.compile`/`append`, `PlanDiff`, and the append-only `PlanStore` | Owns `flows_plans`, `flows_plan_nodes`, `flows_plan_edges`, and migration block `4000`; performs no I/O beyond the database and executes nothing |
| [`@smthrs/artifacts`](/api/artifacts) | The content-addressed artifact store the step cache references by digest: local, remote-over-HTTP, and the combination | Owns no tables and no migration; depends on `crypto` alone. Host access is Effect's `FileSystem` and `HttpClient` tags |
| [`@smthrs/flow`](/api/flow) | The flow authoring model, flows, actions, durable primitives, retry policy, step identity, and the `FlowRuntime` port they execute against | Declares the runtime port; depends on nothing that implements it |
| [`@smthrs/engine`](/api/engine) | The runtime that executes flows: the encoded engine seam, its typed adapter, the in-memory implementation, and the RPC/HTTP façades | Computes action keys above the encoded engine seam |
| [`@smthrs/kernel`](/api/kernel) | Capability sets, grants, and guarded Host decorators | Permission checks occur immediately before Host delegation |
| [`@smthrs/engine-store`](/api/engine-store) | Durable `FlowEngine` implementation composing the journal, run, and cache stores | Claims runs before driving and fences action persistence; owns the deferred/clock tables and composes every migration set |
| [`@smthrs/sync`](/api/sync) | Read-only journal replication protocol and RPC client/server | It does not mutate runs or journal state |
| [`@smthrs/time-travel`](/api/time-travel) | Replay, fork, rewind, compensation, recovery, and retry utilities | Operates through public journal, run-store, step-cache, `Jj`, and time-travel store contracts |
| [`@smthrs/flows`](/api/flows) | The umbrella barrel: every engine package re-exported as a namespace, plus `@smthrs/flow` flat and `TimeTravel` as a service key | Owns no code of its own beyond `namespaces`; the three `platform-*` bundles are deliberately not re-exported |

## Two persistence seams

Each storage package owns its own tables and its own migration set:
`@smthrs/journal` owns `flows_journal_events`, `@smthrs/run-store` owns
`flows_runs` and `flows_attempts`, `@smthrs/step-cache` owns
`flows_step_cache`, `@smthrs/plan` owns `flows_plans`, `flows_plan_nodes`, and
`flows_plan_edges`, and `@smthrs/engine-store` owns
`flows_deferred_completions` and `flows_clock_deadlines`. `@smthrs/database`'s `Migrations` composes those
sets over one `flows_migrations` table, namespacing each package's migration
ids into a reserved block so two packages' `0001_initial` cannot collide.
`@smthrs/engine-store` adds `DurableEngineState`: `layer` persists those waits
through `DurableWriter`, while `layerMemory` remains available for deterministic
tests.

`@smthrs/time-travel` adds audit, receipt, snapshot, lineage-edge, and archive tables through `SqlTimeTravelStore`. Those tables are separate from the journal migration.

## Runtime-specific edges

The core contracts are isomorphic, but not every aggregate is runtime-neutral:

- `@smthrs/engine-store` mints owner identity through the injectable `OwnerIdentity` service rather than reading `process.pid` and `node:crypto` directly, so the package root, and the `@smthrs/flows` barrel above it, bundles for the browser. Running it still needs a browser SQL client for the `DurableWriter` contract, and none ships here.
- Vendor host adapters (`@smthrs/host-cloudflare`, `@smthrs/host-vercel`) live in the [plugins repository](https://github.com/smithersai/plugins).

See [implementation status](/release/support-matrix) and the Cloudflare and Vercel guides in the [plugins repository](https://github.com/smithersai/plugins/blob/main/docs/guides/).
