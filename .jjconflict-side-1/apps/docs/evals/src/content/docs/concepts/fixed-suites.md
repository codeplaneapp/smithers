---
title: "Fixed suites"
description: "Why a suite is validated once, snapshotted, and frozen, and how a binding finds its target."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/evals/docs/concepts/fixed-suites.md"
---

A fixed suite is the input half of an evaluation: named cases, the scorer
bindings that grade them, and the concurrency the runner is allowed. "Fixed"
is the load-bearing property. A committed baseline says "this suite scored
these numbers", and that sentence is only meaningful when the suite that
produced the baseline is the suite being run. So a suite is validated once, at
construction, and then never changes.

## The snapshot

`Suite.make` enforces the fixity mechanically. When the effect runs, it reads
every option, case field, and binding field exactly once, validates what it
read, and copies it with `structuredClone`. The arrays it returns are frozen.

Three consequences follow:

- Mutating the caller's arrays, case inputs, or ratio policies afterwards
  leaves the validated suite unchanged. The suite is a snapshot the caller can
  no longer reach.
- The copy doubles as a data check. A case carrying a function or a class
  instance is not inert data, and `structuredClone` rejects it: construction
  fails with `invalid_suite` naming the offending path.
- Reading each field once closes the getter hole. A getter that returned one
  name to validation and a different name to the suite would hand the system a
  value validation never saw.

## Bindings and identity

A binding says "this scorer grades that flow", and the match is by reference
identity: a run grades an execution with a binding only when the execution's
`target` is the very flow value the binding's `appliesTo` holds. A structurally
equal copy of the flow is graded by nothing.

Identity is what makes a binding durable. Two declarations of a flow with the
same name are different flows, and a baseline recorded against one says
nothing about the other. Reference identity makes that distinction exact
instead of approximate.

The scorer has the same split between identity and label. `Observation.scorer`
is the scorer key, a digest of the scorer's own `{ id, version, config }`
declaration, and it is what a baseline matches on: change the declaration and
the old scores no longer claim to describe the new scorer.
`Observation.scorerName` is the human name from the same declaration, carried
alongside so a report can be read without grepping for the digest. A Markdown
report prints `name (first 8 of the key)`.

For the scorer, binding, and sampling types themselves, see the
[scorers API](https://scorers.smithers.sh/reference/api/).
