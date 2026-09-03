---
description: "The enforced limits of Smithers 1.0.0-rc.0 and the supported alternatives."
---

# Known limitations

Every limit below is explicit: an unavailable command is removed, an unsupported
configuration fails with a typed error, or the boundary is described here. See
the [support matrix](/release/support-matrix) for what is supported.

## Storage and runtimes

Smithers runs durable state on Node.js 22.19 or newer with local SQLite.
PostgreSQL and PGlite are unsupported. `SMITHERS_BACKEND=pglite|postgres` and
`--backend pglite|postgres` fail with `unsupported_database`.

The durable engine does not run under Bun, in a browser, or in an edge worker.
Browser entry points are bundleable client and authoring APIs, not durable hosts.

## Smithers 0.x data

Smithers 1.0 does not load, resume, or transform 0.x run databases or
`.smithers/executions` state. `smithers migrate` may inspect `smithers.db`
read-only to report non-terminal runs, but it never changes that database.
Finish, archive, or discard old runs before migrating project source.

## Removed control surfaces

Hijack and attributed pause are unavailable. Use `steer`, `signal`, `approve`,
`deny`, and `cancel`. Continue-as-new is represented by `Flow.Handoff` rounds;
there is no `Continued` terminal status.

Time-travel replay, fork, and rewind are library APIs in
`@smthrs/time-travel`; their old CLI commands are not available. A checkpoint
in the agent runtime is a pinned git tree taken by a cell call, not a worktree
lane lifecycle.

## Wake and supervision

In-process wakes use `WakeBus`. Cross-process wakes arrive through the
one-second heartbeat sweep and cancel poll. No supervisor process launches an
abandoned run. A run becomes reclaimable when its owner stops renewing its
lease; the default stale window is 30 seconds.

## Provider quota

A provider refusal with a usable deadline can park the run through
`QuotaPolicy.layerDefault()`. A composition may instead bind
`QuotaPolicy.layerUnclassified()` and keep the refusal as a failure. There is
no cross-process quota wake feed, so a dead owner must first lose its lease.

## Detached child flows

`EngineChildren` provides durable spawn, send, and await operations. Awaiting a
child polls its run row rather than parking the caller, so a long child keeps
the caller's round open.

## Plan admission

`Trellis` enforces depth, fanout, and fuel bounds on model-authored plans.
Linked child runs do not count against those bounds, and no self-healing repair
primitive ships.

## Process containment

Cooperative cancellation kills spawned process groups. A host that never
restarts cannot reap processes abandoned by a hard kill, and a remote sandbox
requires its provider's optional `kill` implementation.

### Credential redaction in logs

> **Credential redaction in logs.** Journal rows and Smithers log events use the same `@smthrs/journal` redaction rules. Two limits remain. The rules recognise credential shapes, not arbitrary strings. A child process that writes directly to its own stderr bypasses the Smithers logger.

Redaction is intentionally not applied to executable durable state such as
checkpoints, outcomes, and cache results because replacing those values would
change resumed behavior. Callers should mark values that must never persist as
`Redacted` in their own schemas.

## Upgrading

The [0.x upgrade guide](/migration/1.0) lists every removed CLI form and its
replacement. `@smthrs/migrate` rewrites project source and reports constructs
that require an operator decision rather than imitating unsupported behavior.
