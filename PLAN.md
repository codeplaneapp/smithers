# Smithers 1.0 Release Candidate Migration

## Objective

Replace the current Smithers implementation with the implementation in
`~/flows/flows`, treating that repository as the new Smithers core rather than
as a compatibility layer or a second engine.

The first release from the combined repository will be the
`1.0.0-rc.N` line, beginning with `1.0.0-rc.0`. The release is intentionally a
clean break:

- no JSX workflow API;
- no React reconciler or JSX runtime;
- no old graph, scheduler, driver, or execution loop;
- no promise of source compatibility with Smithers 0.x;
- no dual-engine runtime in the finished tree;
- no migration of active 0.x runs unless a separate, explicitly tested data
  migration is designed.

The canonical authoring model will be the new `Flow`, `Action`, `Plan`, and
Effect APIs. The canonical runtime will be the new engine, durable stores,
journal, control plane, and host-capability packages.

## Why this approach

A wholesale replacement is simpler and safer than adapting the old engine.
The new repository already contains the replacement package graph, durable
execution model, storage layer, control plane, browser and Node host
boundaries, tests, examples, and architectural documentation. Retaining the
old engine beside it would preserve two competing definitions of runs, steps,
events, retries, cancellation, and persistence.

The work is still larger than copying directories. The old repository contains
useful integrations, UI packages, operational commands, deployment adapters,
and hard-won behavioral tests. Those should be migrated onto the new public
contracts where they remain product requirements. Their old engine bindings
should not survive.

The new core continues to use Effect. This migration replaces the old
Effect-based Smithers architecture; it does not remove Effect from Smithers.
The imported tree currently targets Effect 4 RC and should remain internally
consistent on that version.

## Target repository shape

The destination repository becomes the source of truth for Smithers 1.0 and
contains:

1. The complete source-controlled Flows workspace: packages, crates, vendored
   `jj` sources required by the build, apps, scripts, tests, examples, and
   documentation.
2. Selected Smithers UI, integration, provider, deployment, and operational
   functionality after it has been rewritten against the new APIs.
3. A single CLI and a single control-plane protocol based on the imported
   implementation.
4. A migration workflow/skill for upgrading external Smithers 0.x projects.
5. No old JSX authoring stack or compatibility facade.

`@smthrs/*` is the canonical package namespace. `@smthrs/flow` exposes the
authoring primitives and `@smthrs/flows` remains the curated aggregate. The
old unscoped `smthrs` package is not a compatibility facade. It should either
be unpublished for 1.0 or published only as a deprecation/migration notice;
application code should migrate to explicit `@smthrs/*` imports.

## Migration rules

- The implementation in `~/flows/flows` wins every package-name collision.
- Port behavior, not old internal APIs.
- Do not add adapters whose only purpose is to preserve JSX or old engine
  contracts.
- Keep historical behavior tests when they express a requirement that still
  applies; rewrite them against the new public boundary.
- Product integrations depend on public services and ports, not engine
  internals or database tables.
- UI reads stable control-plane DTOs, journal projections, and gateway APIs;
  it does not import engine implementation packages.
- Real backends and real persisted data remain the standard for product and
  end-to-end tests.
- Every package, document, example, script, workflow, and app receives an
  explicit disposition before deletion.

## Phase 0: Freeze the migration contract

Before moving code, define the supported 1.0 RC surface:

- supported runtimes and minimum Node/Bun versions;
- SQLite support for the first RC;
- whether Postgres and PGlite are RC blockers or explicitly unsupported until
  a later RC;
- public packages and exports;
- CLI commands included in the first RC;
- run-control features included in the first RC;
- behavior of existing 0.x run databases and workspaces;
- features intentionally deferred, with release-note wording.

Use the imported repository's versions as the tooling baseline: its package
manager, TypeScript configuration, Effect 4 RC version, formatting, linting,
and build system should win unless a current Smithers release requirement
proves otherwise.

Create a machine-readable or tabular disposition ledger covering every
tracked top-level area in the current repository. Each entry must be one of:

- `replace`: superseded by an imported package;
- `migrate`: behavior is retained but rewritten against the new APIs;
- `keep`: independent of the runtime and safe to retain unchanged;
- `delete`: obsolete, duplicated, generated, or a superseded proof of concept;
- `decide`: blocked on an explicit product decision, with an owner and exit
  condition;
- `import`: a flows-side area copied in Phase 2 by the Phase 1/2 driver; root
  files that must be merged with a surviving file are marked `reconcile` in the
  row's notes.

No `decide` entries may remain at RC time.

## Maintainer decisions required

The following choices materially change the migration. They must be decided
before the affected implementation phase; an agent should not infer them from
the goal of moving the repository wholesale.

| Decision | Recommended default | Consequence of another choice |
| --- | --- | --- |
| Repository of record | Make this repository the only Smithers repository and archive `~/flows/flows` after import verification. | Keeping both active requires a permanent sync and release-ownership policy. |
| Import history | Preserve the imported repository's meaningful commit history or retain an immutable import reference/tag. | A plain copy is faster but makes later archaeology and attribution harder. |
| RC version spelling | Start at `1.0.0-rc.0`, then increment `rc.1`, `rc.2`, and so on. | `1.0.0-rc` is valid but leaves no natural sequence for additional candidates. |
| Versioning model | Give all public first-party packages one synchronized RC version. | Independent versions reduce release churn but make the first cutover and support matrix harder to reason about. |
| Public package set | Publish only packages required by supported consumers; keep build helpers, targets, fixtures, and internal composition packages private. | Publishing every imported package creates a large permanent compatibility surface on day one. |
| Unscoped `smthrs` package | Publish a deprecation/migration notice only; use explicit `@smthrs/*` packages for new code. | A new aggregate implementation is possible, but it becomes another public API that must be designed and supported. |
| CLI binary and package | Keep the user-facing `smithers` binary and make the imported CLI own it. Resolve the imported `flows` binary and private build CLI's `smthrs` binary before packing. | Renaming the command forces changes in scripts, docs, hosted automation, and external projects. |
| Effect as public API | Treat Effect 4 as part of the 1.0 authoring contract and document the exact compatibility range. | Hiding Effect requires a new abstraction layer and is not a wholesale import. |
| Initial database support | Ship the first RC as SQLite-only and fail clearly for Postgres/PGlite. | Preserving old database support requires new drivers, portable migrations, and backend conformance suites before RC. |
| Existing run data | Do not migrate live/in-flight 0.x runs; require finish/archive/discard. Decide separately whether completed history gets a read-only importer. | Transparent migration requires an event, state, lineage, checkpoint, and filesystem semantic mapping that does not currently exist. |
| Required run-control parity | Require correct cancellation and signals; defer hijack, attributed pause, and continue-as-new only if their commands/exports are removed or explicitly unsupported. | Claiming full CLI parity makes all of these RC blockers. |
| Checkpoints and worktree lanes | Defer for the first RC unless production workflows require them; remove misleading commands and docs. | Keeping them in scope requires a new host capability and policy, not a source-level port. |
| Browser and edge claim | Claim browser-bundleable APIs, not a durable browser or edge deployment. | A runnable browser/edge engine needs a shipped durable database and host composition. |
| UI source of truth | Use the UI already built in `~/flows/flows` as the product UI. Treat `../multi` as a disposable prototype and UX reference, not a package or release dependency. | Migrating Multi would spend effort preserving a superseded implementation. |
| Integration placement | Keep generic contracts/actions in core and move vendor/deployment adapters to the plugins repository where possible. | Keeping all adapters in core increases release coupling and the supported dependency surface. |
| Migration-tool distribution | Ship one canonical migration prompt as both a new-engine workflow and a thin installable skill/CLI entry point. | Shipping only a skill is simpler but harder to test and version; shipping only a workflow makes bootstrap from an old project harder. |
| RC compatibility promise | State clearly that the RC is a source migration with no JSX or runtime compatibility. | Partial compatibility will pull the old graph, loader, renderer, and data model back into the new design. |
| Product cutover strategy | Migrate Smithers and the unreleased Plue backend together. Plue may not release until it uses the new Smithers contracts. Multi is outside the release train. | Publishing either Smithers or Plue against mismatched contracts leaves the new UI without a viable backend. |

Record each answer in the disposition ledger and release notes. If a decision
changes later, update the plan and acceptance gates rather than silently
expanding scope during implementation.

## Plue cutover is part of the migration

Plue is the backend for the UI imported from `~/flows/flows`. It is not yet
released and must not be released until it uses the new Smithers runtime and
control-plane contracts.

- `../plue` depends on the old `smithers-orchestrator`/`smthrs` surface and its
  `.smithers` pack contains 57 JSX workflow files.

Removing JSX and replacing the gateway therefore requires a coordinated Plue
migration. Before deleting the old package surface, capture a Plue consumer
contract inventory:

- imported packages, exports, types, and React hooks;
- gateway transport, DTO, websocket, and subscription assumptions;
- workflow discovery, file-extension, and loader assumptions;
- CLI commands and environment variables invoked by scripts or deployment;
- persisted run/event fields displayed by the UI;
- hosted API and authentication contracts shared with Plue;
- production workflows that depend on features proposed for deferral.

Use this inventory to define the minimum new gateway/UI projection and the
minimum RC engine feature set. The cutover is complete only when Plue builds
and passes its real-backend suites without links to removed packages. Its JSX
workflow pack is a primary fixture for the migration workflow, not a reason to
restore JSX compatibility.

`../multi` is a prototype of the UI already implemented in `~/flows/flows`.
It has no migration or release gate. It may be consulted for UX behavior or
used as disposable migration-test input, but Smithers 1.0 must not depend on,
package, or preserve Multi code.

## Phase 1: Remove the superseded Smithers architecture

Delete the old execution system and all code that exists solely to support it:

- `@smthrs/graph`;
- the old `@smthrs/engine` implementation;
- `@smthrs/scheduler`;
- `@smthrs/driver`;
- `@smthrs/react-reconciler`;
- workflow-oriented `@smthrs/components`;
- JSX host nodes and renderers;
- `smthrs/jsx-runtime` and `smthrs/jsx-dev-runtime` exports;
- JSX-aware workflow loaders and templates;
- old database, event, retry, resume, and run-control implementations replaced
  by imported stores and services;
- old engine-specific test helpers, fixtures, generated declarations, and
  documentation.

Remove old JSX examples and workflows rather than translating them during this
phase. The migration workflow developed later will provide the repeatable
translation path and can then be exercised on selected examples.

Delete demo and POC apps by default. Retain an app only when the disposition
ledger identifies a current product or release-validation role. The imported
Flows UI is the product UI; Multi and other copied UI demonstrations are not
independently valuable.

Make this a clearly bounded change so version control remains the recovery
mechanism. Do not mix speculative rewrites into the deletion change.

## Phase 2: Import the new Smithers wholesale

Copy all required source-controlled content from `~/flows/flows` into this
repository, excluding VCS metadata, local databases, dependency directories,
build output, caches, and developer-specific state.

Reconcile rather than blindly overwrite root-level files:

- `package.json` and workspace definitions;
- `pnpm-lock.yaml` and `bun.lock`;
- TypeScript, lint, formatting, test, release, and CI configuration;
- `AGENTS.md`, contribution guidance, licenses, and repository metadata;
- documentation and website configuration;
- release automation and npm provenance configuration.

Import the new repository's package structure intact. For colliding names—
including engine, gateway, memory, observability, sandbox, scorers, testing,
and time-travel—the imported package is the starting implementation. Never
merge the old and new source trees file by file.

After import:

1. Rename product-facing references from the temporary Flows repository name
   to Smithers where appropriate, without renaming meaningful `Flow` domain
   concepts.
2. Remove stale cross-repository links and assumptions about `~/flows/flows`.
3. Confirm every internal dependency resolves from this workspace.
4. Run the imported repository's tests unchanged before beginning feature
   ports. This establishes a trustworthy baseline.

## Phase 3: Establish the 1.0 package and release contract

Set publishable packages to `1.0.0-rc.0` and update all exact internal package
dependencies consistently. Private apps and fixtures do not need the public
version unless release tooling requires it.

Synchronize both lockfiles whenever manifests change. Validate:

- package names are unique;
- exports resolve in Node, Bun, and supported browser builds;
- public types are generated and current;
- package files contain the required sources, migrations, and assets;
- no package imports files through unpublished workspace-relative paths;
- no `0.1.0`, `0.35.0`, old Effect beta, or old package-name assumptions remain
  in publishable manifests;
- release ordering handles internal dependencies correctly;
- npm dry runs produce the intended tarballs;
- the CLI executes this working tree during development and the packaged CLI
  after installation.

Use `1.0.0-rc.N` for successive candidates. Do not mutate an already published
candidate.

## Phase 4: Migrate retained functionality

### Integrations

Port integration behavior onto the new capability, action, notification,
control, and durable-wait APIs. Preserve reusable external client code,
authentication, webhook verification, cursor handling, rate-limit knowledge,
and provider-specific error classification.

Discard JSX components, direct old-database access, old signal delivery,
React context dependencies, and old engine imports. Each integration should
have a narrow host/service layer plus actions or flows that consume it.

Start with integrations required by a real application. Every migrated
integration needs a real-backend contract or end-to-end test.

### UI and gateway

Treat the imported gateway, control, journal, run-store, notification, and sync
models as the backend contract. Retain useful UI packages only after replacing
their old gateway/client assumptions.

Candidate UI packages include `ui`, `ui-core`, `ui-styleguide`, `gateway-ui`,
`gateway-react`, `gateway-client`, `devtools`, `tui`, and `tui-ui`. For each:

1. identify the screens and components used by the imported Flows UI;
2. delete copied or unconsumed components;
3. define stable new DTOs/projections instead of exposing store rows directly;
4. retarget queries, subscriptions, run controls, approvals, logs, and graph
   views to the new gateway;
5. prove behavior against a real new-engine run.

The old `@smthrs/components` package is not part of this UI set; it is primarily
the JSX workflow DSL and should be deleted.

### CLI and operations

Use the imported CLI as the base. Port only commands that remain meaningful
with the new engine. Commands must call public control-plane services rather
than old database helpers.

Pay special attention to start/resume, inspect, logs/events, cancel/pause,
signals and approvals, time travel, worktrees/checkpoints, gateway/UI startup,
agent registration, and database migration. Unsupported commands should fail
with an explicit migration message rather than silently approximating old
behavior.

### Providers and host adapters

Audit agents, model providers, OpenAPI, sandbox providers, VCS, cloud hosts,
and deployment adapters individually. Move provider policy out of the engine
and bind it through the new host/capability/plugin seams. If an adapter belongs
in the separate plugins repository, move it there rather than preserving an
accidental core dependency.

### Documentation and examples

Rewrite documentation around the new mental model. Do not mechanically rename
old concepts.

Required documentation includes:

- installation and the RC warning;
- writing and running a flow;
- actions, stable identities, retry, caching, and compensation;
- durable waits, signals, child flows, cancellation, and recovery;
- journal, run store, control plane, and gateway;
- Node/browser host composition;
- database support and operational limits;
- time travel and checkpoint support actually available in the RC;
- migration from 0.x, including removed JSX APIs;
- package selection and public API reference.

Migrate a small set of examples that collectively exercises the supported
surface. Delete examples that only demonstrate removed APIs or duplicate a
better example. All documented commands must run in CI.

## Phase 5: Close or scope correctness and parity gaps

The wholesale import is not automatically release-ready. Before the first RC,
triage the findings already documented in the new repository's Smithers
replacement and applicability audits.

Correctness defects in supported features are release blockers, especially:

- cancellation durability, recursive child cancellation, and scope cleanup;
- terminal-state control requests and attribution;
- durable retry bounds;
- ownership, stale-run sweep, and registration-before-resume behavior;
- retention and bounded journal/sync behavior;
- time-travel atomicity and workspace identity;
- process and child-agent containment.

Parity gaps may be explicitly excluded from the first RC instead of delaying
it, but exclusions must be enforced and documented. Known candidates include:

- Postgres/PGlite storage layers and migrations;
- hijack and attributed pause/control;
- continue-as-new terminal semantics;
- provider quota park/wake policy;
- checkpoints and worktree lanes;
- cross-process event-driven wake;
- edge/serverless execution parity;
- old eval/optimization and UI-adjacent engine features.

An excluded feature must not appear to work partially. Hide it, remove its
command/export, or return a precise unsupported error.

## Phase 6: Build the Smithers 0.x migration workflow

Create an agent-driven migration workflow and a focused migration skill. This
is not a compatibility library. It upgrades application source to the new
model and leaves an auditable report.

Suggested deliverables:

- a new-engine workflow such as `migrate-smithers-v1`;
- a concise `SKILL.md` explaining when and how to run it;
- a high-quality migration prompt with explicit invariants and examples;
- source scanners and deterministic checks where they are more reliable than
  prompting;
- representative real-project fixtures and end-to-end migration tests;
- a generated migration report listing changed files, unresolved semantics,
  unsupported features, and verification results.

The workflow should:

1. Detect package versions, imports, JSX pragmas, TypeScript JSX settings,
   workflow files, CLI scripts, config, integrations, and database backends.
2. Inventory removed constructs such as `Workflow`, `Task`, `Sequence`,
   `Parallel`, branches, loops, approvals, waits, signals, subflows, sandboxes,
   worktrees, and output accessors.
3. Produce a proposed semantic mapping to `Flow`, `Action`, Effect control
   flow, durable waits, child flows, capabilities, and layers.
4. Flag constructs without a safe automatic translation before editing.
5. Checkpoint the project, transform one workflow or integration at a time,
   and preserve unrelated application changes.
6. Update dependencies, imports, configuration, scripts, and documentation.
7. Run install, formatting, typecheck, unit tests, and relevant end-to-end
   tests.
8. Iterate on failures with the migration contract in context.
9. Emit a concise final report and a manual follow-up list.

The prompt must explicitly prohibit recreating the old JSX runtime, embedding
an old scheduler in application code, or hiding unsupported semantics behind
`any`. It should prefer direct, idiomatic new APIs over shape-preserving
translations.

The migration workflow should not rewrite or resume active 0.x run state. It
must detect live or persisted old runs and instruct the operator to finish,
archive, or explicitly discard them according to the published migration
policy.

## Phase 7: RC validation

The repository is ready for the maintainer to publish only when all of the
following pass from a clean checkout:

- frozen installs for pnpm and Bun;
- formatting, lint, and typecheck;
- package-level and full unit tests;
- real SQLite persistence and crash/restart suites;
- browser bundling for advertised browser-safe entry points;
- CLI end-to-end tests using the working-tree CLI;
- real-backend integration tests for every integration included in the RC;
- documentation generation and link checks;
- package export/type synchronization checks;
- dependency-cycle and duplicate-package-name checks;
- npm pack/dry-run inspection for every public package;
- installation into clean Node and Bun consumer fixtures;
- execution of all published examples;
- migration workflow tests against representative 0.x projects;
- clean builds and real-backend contract tests in `../plue`;
- scans proving Plue no longer imports removed Smithers packages or relies on
  JSX workflow loading;
- secret, generated-file, stale-version, and obsolete-import scans.

Perform a manual smoke test covering at least: create and run a flow, restart a
process during execution, resume a durable wait, deliver a signal, cancel a
run, inspect journal/events, use the gateway/UI against the run, and exercise
one real integration.

## Release artifacts

Prepare, but do not publish:

- versioned manifests and both lockfiles;
- generated public types and documentation;
- package tarballs or reproducible pack commands;
- changelog and `1.0.0-rc.0` release notes;
- a removed/deprecated API list;
- supported-runtime and supported-database matrices;
- known limitations and deferred parity items;
- migration guide and migration workflow/skill;
- clean-checkout verification evidence;
- exact maintainer publish commands and package order.

Publishing remains a manual maintainer action.

## Completion criteria

This migration is complete when:

1. only one Smithers execution architecture remains;
2. the old JSX and reconciler stack is absent from source, exports, examples,
   docs, templates, and generated artifacts;
3. all imported new-engine tests pass in this repository;
4. every retained integration, UI, CLI, and host feature uses new public APIs;
5. every old repository path has a final recorded disposition;
6. supported RC behavior passes clean-checkout and real-backend validation;
7. unsupported behavior is explicit and documented;
8. external 0.x projects have an agent-led, tested migration path;
9. Plue runs against the RC contracts without compatibility links and is ready
   to back the imported UI;
10. every maintainer decision above has a recorded answer;
11. the maintainer can publish `1.0.0-rc.0` without further repository edits.
