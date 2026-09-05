# Fixture: `jsx-single.migrated`

The hand-written 1.0 output for the `jsx-single` fixture. `Checks.run` and `Checks.discovery` run against it, so it is the definition of a clean migration: no old import, no JSX pragma, no React under `flows/`, no escape hatch, no scheduler loop, no direct database access, a `description` the registry can read, a descriptor that admits the flow's own contract, and a warning-free discovery scan.

Origin: written by hand from `jsx-single/simple-workflow.jsx`, following `examples/src/11-agent-step.ts` in the flows tree.

`flows/simple-workflow/flow.ts` carries two declarations, because flows HEAD needs both:

- the named `SimpleExample`, a `@smthrs/flow` `Flow.make(tag, options)` with the durable body, imported as `DurableFlow` so the default export keeps the `Flow` name. The old `<Sequence>` of two `<Task agent>` elements is one `Node.bindPlanned` over two `AgentAction`s.
- the default export, a `@smthrs/core` `Flow.make(options)` declaration carrying the `description`, `input`, `output`, `capabilities`, and `effects` the registry reads. `@smthrs/flow`'s options do not take a `description`, and `Discovery` reads the literal token sequence `export default Flow.make(` without evaluating the module, so the descriptor is its own declaration and it is the one that keeps the name `Flow`.

Two declarations are not two behaviors. The descriptor admits `SimpleExample` and nothing else: its `input` and `output` ARE that flow's `payload` and `success`, and `Checks.run`'s "every flow module's descriptor describes the flow it declares" reads that out of the source. `test/MigratedFixture.test.ts` and `test/Checks.test.ts` pin the executed half by building `SimpleExample` and finding the two agent calls with the second waiting on the first and the `Article` success schema.

The descriptor carries no `body`, and at this version it cannot. `@smthrs/core`'s `body` returns a `@smthrs/core/Node`; `SimpleExample.call` returns a `@smthrs/plan/Node`, a different type in a different package, so `body: (input) => SimpleExample.call(input)` is `TS2322: Property '[TypeId]' is missing`, and a cast has no place in migrated output. Binding the two by body is the core-runtime bridge, and this file gains that line the day the bridge lands; the checks already accept a delegating body, so only this fixture and its two tests change then.

Each `seat` is the model the source names: `jsx-single/simple-workflow.jsx` builds both agents with `anthropic("claude-sonnet-5")`, so both steps read `seat: "anthropic:claude-sonnet-5"`. The tool has no default seat, and `Checks.run` fails a migrated file whose seat literal does not appear in the unit's source.

The two MDX prompts became template literals on the two `AgentAction`s, which is why the fixture has no `prompts/` directory. The zod schemas became `effect/Schema` structs. The bun preload, the `bunfig.toml`, and the `mdx-assets.d.ts` are gone with the loader they configured.
