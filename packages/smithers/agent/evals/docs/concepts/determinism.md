---
title: "Determinism and canonical artifacts"
description: "Caller-supplied run identity, deterministic sampling, and byte-stable serialization."
sidebar:
  order: 3
---

Two runs of the same suite over the same inputs produce byte-identical
observations, and two identical comparisons produce byte-identical reports.
That property is engineered, not accidental, and it comes from four decisions.

## Identity and time come from the caller

`Runner.run` takes `runId` and `at` as options and stamps every observation
with them. Nothing in a run reads a clock or generates an identifier, so the
caller controls every input that could vary. Pin `at` to a fixed instant when
you want a suite to be comparable across days: observation timestamps are report
material, and pinning them keeps two runs of an unchanged suite byte-identical.

The format is strict because reproducibility is strict: `at` must be a
canonical UTC timestamp with millisecond precision that parses and re-renders
to itself, and anything else fails with `invalid_run_options`.

## Sampling is decided, not rolled

A binding's sampling policy selects which executions a scorer grades, and the
selection is a pure function of the policy, the step key, and the scorer key.
The same run over the same inputs samples the same executions every time, so a
sampled baseline stays comparable with the next sampled run. For the policy
types, see the [scorers API](/api/scorers).

## Job identity is injective

Every score job carries an identity built from the suite name, run identity,
sample identity, case, step key, scorer key, and the job's index, encoded as a
JSON array. Encoding a tuple rather than joining strings on a delimiter is
what makes the identity injective: two distinct jobs can never produce one
identity, so a correlated batch runner can always attribute its results.

## Serialization is total and canonical

`Baseline.write` and `Report.json` share one encoder. It sorts object keys by
code unit, drops `undefined` members, and normalizes negative zero. Everything
JSON cannot express becomes a bracketed marker that names what was there:
`[circular]`, `[depth exceeded]`, `[NaN]`, `[Infinity]`, `[-Infinity]`,
`[bigint n]`, `[function]`, `[symbol]`, and `[unreadable: …]` when a foreign
operation throws. An `Error` becomes an object holding its own fields plus
`name` and `message`. A `Date` becomes its ISO string, a `Set` becomes an
array, and a `Map` becomes an array of key/value pairs. Embedded strings are
capped at 8192 code units and nesting at 64 levels.

The encoder is total: a report of a broken run is still a report, never a
thrown `RangeError` out of a function typed `string`. And it redacts nothing:
a suite whose cases carry secrets must not print the report where the log is
readable.
