---
description: "The model registry Smithers publishes as data, what reads it, and how a seat is chosen in 1.0.0-rc.0."
---

# Model registry

Smithers publishes a model registry as data rather than as code:

- [`docs/data/sota-models.json`](https://github.com/smithersai/smithers/blob/main/docs/data/sota-models.json)
  lists model identifiers with their provider, context window, and status.
- [`docs/data/sota-benchmarks.json`](https://github.com/smithersai/smithers/blob/main/docs/data/sota-benchmarks.json)
  lists the benchmark rows those entries cite.

Both files stay at those paths on the `main` branch. An installed Smithers 0.x
CLI fetches the registry from there in its update check, so the path is a
published contract even though 1.0.0-rc.0 reads neither file at runtime.

## What 1.0.0-rc.0 does with it

Nothing automatic. The release ships no registry generator, no `sota` command,
and no bundled copy of the registry inside the CLI. A model is chosen where the
action is declared:

```ts
const Review = AgentAction.make("example/Review", {
  seat: "anthropic:claude-sonnet-4-5",
  ...
})
```

The seat string is resolved by the `SeatResolver` service, which is the only
place a credential lives. Core resolves seats from `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, and `SMITHERS_OPENAI_AUTH=chatgpt`.
There is no multi-account pool and no automatic failover between providers: a
quota error fails the model call with `quota_exceeded`, and the run is not
parked and re-woken. See
[known limitations](/release/known-limitations).

## Using the registry yourself

The JSON is a plain document with no Smithers dependency. Read it at build time
to pin a seat string, or read it in your own `SeatResolver` to choose a model
per environment. Nothing in the engine will second-guess the seat you return.

See [writing a flow](/guides/writing-a-flow) for how an `AgentAction` declares
its seat, its output schema, and its correction budget.
