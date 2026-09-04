---
title: "Run the migration as a durable flow"
description: "Drive the migration from your own program: build the options, run it on the bundled Node composition, or register the flow with a durable host so it plans, approves, and runs under the journal."
sidebar:
  order: 7
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/migrate/docs/guides/run-as-a-durable-flow.md"
---

`apply` is one flow execution, `smithers/migrate-v1`, with one child execution
per unit. Three entry points reach it, and they are the same flow: the
`smithers-migrate` bin, the [`smthrs migrate`](https://smithers.sh/docs/reference/cli/migrate/) verb, and your own
program.

This is the editing half of the package, so it needs the optional `@smthrs/*`
dependencies a default install already brings.

## Run it on the bundled Node composition

`Command.runNode` builds everything the migration needs from the project
itself, runs the flow, and returns the report:

```ts
import * as Command from "@smthrs/migrate/flow/Command"
import * as Effect from "effect/Effect"

const options = Command.optionsOf(
  {
    root: process.cwd(),
    scan: false,
    apply: true,
    seat: "anthropic:<model>",
    allowUnsafe: undefined,
    acknowledgeRunState: false,
    allowNoVcs: false,
    keepOldSources: false,
    unit: undefined,
    maxRepairRounds: undefined,
    reportDir: undefined,
    flowsDir: undefined,
    verifyInstall: undefined,
    verifyFormat: undefined,
    verifyTypecheck: undefined,
    verifyTest: undefined
  },
  process.cwd(),
  process.env
)

const report = await Effect.runPromise(
  Command.runNode(options, { environment: process.env })
)

console.log(Command.render(report, "human", Command.reportDirectory(options)))
process.exitCode = Command.exitCode(report)
```

`Command.optionsOf` is the same conversion the bin and the CLI verb use, so
your program takes the flags they take, with the same rules: `--scan` wins over
`--apply` when both are set, and only `SMITHERS_HOME`, `HOME`, and `TMPDIR`
leave the environment for the flow's payload.

`Command.exitCode(report)` returns `0`, `1`, or `3`. Treat `3` as parked, not
failed: the project is intact and a person has a decision to make.

Handle the failure channel with `Command.isMigrateError`, which checks the
class and its schema rather than a `_tag` string any object can carry:

```ts
import * as Command from "@smthrs/migrate/flow/Command"

if (Command.isMigrateError(error)) {
  console.error(`${error.code}: ${error.message}`)
}
```

## Why the composition is built from a scan

`Command.layerNode` is effectful and fails with the scanner's own error,
because the composition has to know two things the caller does not: which paths
hold 0.x run state, so the grant store can deny every filesystem action on
them, and which commands verify a unit, so the model can run them before it
answers. Both come from a read-only scan of the project.

## Survey now, run later

A durable host approves a plan in one process and runs it in another, so the
two halves are separate:

```ts
import * as Command from "@smthrs/migrate/flow/Command"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const surveyed = yield* Command.survey(options)
  return yield* Command.launch(options, surveyed)
})
```

The survey runs before the flow because a flow body is plan time: the unit list
is topology, and topology cannot come from a value a step returns. The flow
scans again inside its own sealed step and refuses, with `stale-plan`, a
project that has moved on since the survey. `Command.run` is `survey` followed
by `launch` for the common case.

`Command.commandsOf(result, options)` gives the verification commands a survey
implies, so a host can show them before anything is approved.

## Register the flow with a durable host

A host that already has an engine takes the migration's own registrations:

```ts
import * as Command from "@smthrs/migrate/flow/Command"

const registerFlows = Command.registration
```

`@smthrs/flows`' `NodeRuntime` takes this as its `registerFlows` layer, and
then `smthrs plan migrate`, `smthrs approve`, and `smthrs run` execute the same
flow under the same journal as everything else. `Command.flowId` is the name
the control plane knows it by, `system/migrate`.

The flow's own tag is `smithers/migrate-v1` and each unit runs as
`smithers/migrate-v1/unit`.

## How the graph is ordered

Every step takes a value from the step before it, and that is the ordering. A
plan is a dataflow graph, so a node nothing depends on is free to run whenever
the engine likes. The checkpoint's record feeds the source capture, the capture
feeds the rewrite, the rewrite's account of what it changed feeds the
verification, and both feed the step that settles the unit.

The units are in the flow's payload rather than in a value the scan step
returns, for the same reason: `Node.andThen`'s builder runs once against a
placeholder before anything executes, so a graph cannot fan out over a list
produced at run time. The scan still runs inside the flow, is still journaled,
and is still what the gate and the report read.

## The seat is a role

The flow declares one seat, `migrate`, and the resolver maps it onto the
`provider:model` you named. No model id is hard coded anywhere in this package,
so a resolver with no seat and no key refuses by name rather than guessing, and
the unit fails with that refusal in its report entry:

```text
Set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY or pass --seat <provider:model> to run the migration
```

With a key but no seat, the refusal names the provider it found a key for
instead.

## Related

- [Checkpoints and confinement](/concepts/checkpoints/): the grant rules
  the composition installs.
- [API reference](/reference/api/): every export of every flow module.
