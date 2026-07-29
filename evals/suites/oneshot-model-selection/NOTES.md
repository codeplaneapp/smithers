# oneshot-model-selection

Checks that an agent grounded in the shipped Smithers guidance predicts which
agent and model `smithers oneshot` auto-selects for a goal, given a set of
usable agents. This pins the registry v8 doctrine: oneshot routes by task
shape, and every rung is availability-gated.

| scenario | required first seat |
| --- | --- |
| UI goal, everything usable | opencode `kimi-for-coding/k3` (then pi `kimi-coding`/`k3`, then kimi CLI `kimi-code/k3`) |
| Backend goal, everything usable | claude `claude-opus-5` |
| UI goal, no kimi seat usable | claude `claude-opus-5`, backed by `claude-fable-5` |
| UI goal, only pi usable | pi `--provider kimi-coding --model k3` |
| UI goal, only the kimi CLI usable | kimi `kimi-code/k3` |
| Explicit `--model opus` on a UI goal | `claude-opus-5`; explicit flags beat classification |
| Status introspection | `smithers oneshot --status "<goal>"` prints `taskType` plus the chain |

The deterministic twin of this suite lives in
`apps/cli/tests/oneshot.test.js` ("oneshot task-aware routing"), which pins the
real `resolveOneshotChain` matrix in CI; these cases pin that the DOCS teach
the same doctrine clearly enough for a weak model to apply it.

## Running

```bash
bun evals/harness/run-suite.ts oneshot-model-selection -j 4                 # full suite
bun evals/harness/run-suite.ts oneshot-model-selection --only-model haiku   # focused
```

Cases are seated on haiku/sonnet only, matching oneshot-routing: a
routing-guidance suite should never go red on agent-CLI infrastructure.
