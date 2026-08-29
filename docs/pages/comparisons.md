---
description: "How the Smithers caching model compares with TurboRepo, Nx, and Bazel, and what a build system does not keep."
---

# Comparisons

Smithers takes its caching model from build systems and its execution model from durable workflow engines. This page compares the implementation with [TurboRepo](https://turborepo.com), [Nx](https://nx.dev), and [Bazel](https://bazel.build), three build systems that also key work and cache the results. For the workflow-engine side (Temporal, Restate, Inngest), see the prior-art table in [External](/external).

## The Effect workflow fork

The Smithers engine began as a fork of Effect's experimental [`effect/unstable/workflow`](https://github.com/Effect-TS/effect/tree/main/packages/effect/src/unstable/workflow) module, vendored into `@smthrs/flow` and `@smthrs/engine` at `effect@4.0.0-beta.102`. Workflow, Activity, WorkflowEngine, and WorkflowProxy became Flow, Action, FlowEngine, and FlowProxy; DurableDeferred, DurableClock, and DurableQueue keep their upstream names. The fork exists because Smithers changes identity and retry semantics ([design decision D11](/design-decisions)); everywhere else it follows the upstream patterns: services as layers, Schema-typed contracts, the effect repo's module and naming conventions. [`VENDOR.md`](https://github.com/smithersai/smithers/blob/main/packages/engine/VENDOR.md) records the fork point and every behavioral difference. The rest of this page covers what the fork adds that upstream does not have: build-system caching discipline over the same durable primitives.

## At a glance

All four systems run the same loop: key a unit of work by everything it consumes, look the key up in a cache, run only on a miss, store the result under the key. They differ in the unit of work, when the key is computed, what a result contains, and what happens when the process dies mid-run.

| | TurboRepo | Nx | Bazel | Smithers |
| --- | --- | --- | --- | --- |
| What it is | monorepo task runner | monorepo task runner and project graph | build system | durable-execution engine |
| Unit of cached work | a package script run | a target run | an action: a command with declared inputs and outputs | an action: a Schema-typed effect |
| Key inputs | hashed package files, lockfile, env allowlist, task config, upstream task keys | hashed project files, runtime and env inputs, upstream target keys | command line, digest of every declared input file, environment | caller identity, declared cache environment, filesystem boundary, as canonical JSON hashed with SHA-256 |
| When keys are computed | at run start, by scanning and hashing | at run start, by scanning and hashing | incrementally, from tracked file digests | at planning time, with no I/O |
| Stored result | files matching declared output globs, plus the log | declared output files, plus the terminal output | output files in a content-addressed store | the encoded success or error exit; file outputs go to the content-addressed artifact store |
| Invalidation | re-hash everything each run | re-hash everything each run | Skyframe dirties reverse dependencies | an edited declaration re-keys the node and its dependent cone |
| Hermeticity | trusted declarations | trusted declarations | OS-level sandboxing, local or remote | a cache-admission gate that requires hermeticity evidence |
| Remote sharing | remote cache, hosted or self-hosted | Nx Cloud cache and distributed agents | remote cache and remote execution over a content-addressed store | artifacts local and remote; cache rows stay in the engine's database |
| Crash recovery | rerun; finished tasks hit the cache, the interrupted one restarts | same, per target | same, per action | resume; replay recorded steps, continue at the first unrecorded boundary |

## The unit of work

TurboRepo and Nx cache a task: one package script or executor target, a whole process. Bazel caches an action: one command with declared input and output files. A Smithers action is a typed effect, not a process: `Action.make` declares payload, success, and error schemas, and the cache stores the encoded exit, decodable through them. A build system's result is output files plus a replayed log; a Smithers result is a typed value, with file outputs in the content-addressed artifact store (`@smthrs/artifacts`).

## How the key is computed

TurboRepo and Nx scan at run start: they hash the files a task can read, an environment-variable allowlist, the task configuration, and every upstream task's key. Bazel derives an action key from the exact command line and the digest of every declared input file, kept current through Skyframe.

Smithers computes keys with no I/O. `@smthrs/plan` compiles a flow body into a keyed graph whose declared effects carry read and write paths, never digests. The engine combines caller identity, the complete declared cache environment, and the filesystem boundary into one input, serialized as RFC 8785 canonical JSON and hashed with SHA-256 (`@smthrs/canonical`, `@smthrs/keys`, `@smthrs/crypto`). [Data structures](/data-structures) specifies the shapes.

The fail-closed default is the practical difference. In TurboRepo and Nx an undeclared input is a silent stale-cache bug. In Smithers, an action without a complete cache environment gets a key that includes the current execution ID: memoized within the run, never reused across runs. Under-declaring narrows reuse instead of corrupting it.

## Invalidation

Skyframe keeps a reverse-dependency graph: a changed file dirties its consumers, and dirtiness propagates until clean nodes stop it. TurboRepo and Nx keep no graph state and re-hash everything each run. Smithers re-keys: a node's key is a function of what it consumes, so an edited declaration changes that key and its dependent cone's, nothing else. No reverse-dependency index, no dirtying pass.

## Hermeticity

A cache is only as correct as its guarantee that the work read nothing outside its key. Bazel enforces it with OS-level sandboxing, local or remote. TurboRepo and Nx trust the declarations. Smithers takes Skyframe's admission gate: a result is reusable across runs only with evidence that execution stayed inside its declared boundary. The shipped `StepBoundary` measures read sets and materializes declared outputs but cannot detect writes outside them, so its evidence is refused and cross-run admission stays closed; production hermetic execution is on the [contributor plan](/contributing), with Bazel's sandbox as the bar.

## What a build system does not keep

Build systems persist nothing about a run in progress.

**Recovery.** Kill a build and finished units stay cached, but the interrupted unit restarts from zero and the run has no identity to resume. Smithers journals every attempt in the same transaction as its state transition, so a restarted process claims the run, replays recorded steps, and continues at the first unrecorded boundary.

**Suspension.** `DurableDeferred.await` and `DurableClock.sleep` park a run for hours or days, holding no process, while it waits on an external completion or a human decision. A build task either runs or does not exist.

**Ownership.** A compare-and-swap claim, an activation fence, and a heartbeat keep two processes from driving one run. Build tools serialize with a workspace lock.

**Typed failure.** A failed action lands in the error channel as a value of its declared error schema; a failed task is an exit code and a log.

**Time travel.** `@smthrs/time-travel` forks, rewinds, and compensates over recorded history. A build cache has no history to rewind.

## Compared with workflow engines

A build system is one comparison; a durable workflow engine is the other. The
table is about shape, not quality: each row is a design choice with a cost.

| | Temporal | LangGraph | Smithers |
| --- | --- | --- | --- |
| Recovery model | replay workflow code against event history | re-enter a graph node from checkpointed state | replay the flow body against the journal, skipping recorded actions |
| What you deploy | a server cluster and worker fleets | your own process plus a checkpoint store | one Node process and a SQLite file |
| Determinism rules | yes, side effects live in activities | not enforced by the runtime | yes, side effects live in actions |
| Step identity | the activity's name and sequence | the node's name | a content-addressed step key over inputs, capabilities, and the measured boundary |
| Typing | SDK types per language | Python types, loosely checked at the edges | Effect Schema on every payload, success, and error, encoded into the journal |
| Human gates | signals and queries you design | an interrupt you handle | plan-level and node-level approvals that park the run |
| Host access | unrestricted inside an activity | unrestricted | a closed host list decorated by a capability kernel |

Smithers is closest to Temporal, deliberately: replay against a durable history
is the same mechanism, and the vendored Effect workflow surface diverges from
upstream by tightening it rather than loosening it. The differences that matter
are that a step is addressed by its content rather than by its name, so renaming
an activity cannot corrupt replay and two runs computing the same work share one
result; and that the deployment is one process with a file, which is what makes
the engine embeddable in a CLI or an application rather than a platform a team
operates.

What Temporal has that this release does not: a cluster, worker fleets,
multi-language SDKs, visibility search, and schedules. What LangGraph has that
this release does not: a graph-authoring UI and a Python ecosystem.

## What Smithers is not

Smithers is not a build tool: no target discovery, no file watcher, no toolchain model, no terminal UI, no executor fleet. For building a monorepo, use TurboRepo, Nx, or Bazel. Smithers is an embeddable engine for programs that need build-system caching discipline over durable, typed, long-running effects.

## Reading next

[External](/external) covers the durable-execution prior art and the implementation status behind every claim above. [Architecture](/architecture) maps the packages that implement these mechanisms.
