---
description: "What a Smithers release promises, what it reports, and what 1.0.0-rc.0 explicitly does not carry forward from 0.x."
---

# Compatibility policy

Smithers release notes treat a consumer-visible contract change as an upgrade
note, even when semantic versioning would call the change additive. That
matters for exhaustive TypeScript switches, lookup tables, non-TypeScript
clients, and readers of persisted data.

## The 1.0 promise

Smithers 1.0.0-rc.0 is a source migration, not a compatible upgrade. It provides no JSX workflow API, no `smthrs/jsx-runtime` or `smthrs/jsx-dev-runtime`, no React reconciler, no `<Workflow>`, `<Task>`, `<Sequence>`, `<Parallel>`, `<Loop>`, `<Ralph>`, `<Branch>`, `<Approval>`, `<Signal>`, `<Timer>`, `<Subflow>`, `<Worktree>`, or `<Saga>` components, no `createSmithers`, `runWorkflow`, `renderFrame`, or `SmithersCtx`, no `smthrs` facade, no 0.x CLI verbs beyond those listed in the 1.0 command table, no 0.x gateway protocol, and no ability to load, resume, or migrate 0.x run databases. No shim, adapter, or compatibility layer will be published. Flows are written against `@smthrs/flow` (`Flow`, `Action`, durable waits, `RetryPolicy`), `@smthrs/engine`, `@smthrs/control`, and Effect `4.0.0-rc.108`, and run on Node.js 22.19.0 or later with local SQLite. Existing 0.x projects migrate their source with the `migrate-smithers-v1` workflow (`smithers migrate`), which rewrites workflows, imports, configuration, scripts, and docs and reports every construct it could not translate. Runtime behavior between 0.x and 1.0 is not equivalent and is not intended to be.

[Migrating from 0.x](/migration/1.0) is the procedure, and
[known limitations](/release/known-limitations) is the list of what a candidate
excludes.

## The Effect pin

Every published package declares `effect` and each `@effect/*` package that
follows Effect's version line at exactly `4.0.0-rc.108`. The supported range is
that single version.

Install the same exact version. A project that resolves two Effect instances is
unsupported: schema internals are not interoperable between instances, so a
value encoded by one is not decodable by the other. Each candidate declares one
exact Effect version, and a candidate that moves the pin lists the move as a
breaking change in its own notes.

## What every release reports

The upgrade notes of each release list every known change to these contracts:

- run, node, event, error-code, and other string-enum values;
- public exports, package subpaths, and binary resolution;
- flow discovery, host layers, and plugin entry points;
- CLI flags, exit codes, and machine-readable output;
- control RPC payloads, gateway frames, database schema, and serialized
  payload shapes;
- defaults whose change can alter an existing flow.

The section says so explicitly when a release has no consumer-visible changes.
An added enum member is listed, because it can break an exhaustive consumer even
though it removes nothing. A correction discovered after a release is added to
that release's upgrade notes rather than to the next one.

## Consumer guidance

Pin the Smithers version you run in production and read every changelog between
the pinned version and the target. For wire values, handle the documented union
and keep a visible unknown fallback beside it. Preserve unknown values in logs
and telemetry rather than coercing them.

In particular, treat an unknown parked or waiting status as suspended and
non-terminal. The 1.0.0-rc.0 run statuses are `accepted`, `running`, `parked`,
`waiting-approval`, `cancelled`, `completed`, and `failed`; there is no
`Continued` status.

The current request and receipt shapes are generated from the schemas in
[the control plane](/control).

## Release lines

A release candidate carries no support promise beyond the candidate itself.
Candidates publish to the `rc` dist-tag; `latest` still resolves the Smithers
0.x line until 1.0.0 is final. A published candidate is never mutated: a fix
ships as the next candidate.

There is no long-term-support line and no backport window today. No older minor
release is promised fixes. A future LTS channel will be announced here with its
version range, maintenance window, and backport policy before it is offered as
supported.
