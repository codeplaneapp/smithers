# ToolRun

Runs one arbitrary external command for its side effect: a deploy, a migration,
a training-job launch, a release upload. This is the run-kind sibling of
[ToolBuild](tool-build.md). `ToolBuild` produces cached file outputs; `ToolRun`
performs an irreversible operation that has none.

```ts
import { Smithers } from "@smthrs/targets"

const fireworksKey = Smithers.Secret("FIREWORKS_API_KEY")

export const sftLaunch = Smithers.ToolRun({
  command: "firectl",
  args: [
    "supervised-fine-tuning-job",
    "create",
    "--base-model",
    "kimi-k3",
    "--dataset",
    "pilot-sft-v0",
    "--output-model",
    "smithers-authoring-pilot-v0"
  ],
  inputs: [],
  deps: [],
  secrets: [fireworksKey],
  cwd: "evals/authoring"
})
```

Run it explicitly, and only through the `run` verb:

```
pnpm exec smthrs run '//evals/authoring:sftLaunch'
```

## When to use it

Reach for `ToolRun` when an operation changes external state and has no file
output to cache. It is the deliberate escape hatch for a one-off command, the
way [ToolBuild](tool-build.md) is for a one-off build. When the operation has a
stable identity, add a purpose-built target type instead: the release targets
[NpmPublish](../../../../targets/src/NpmPublish.ts) and `JsrPublish` are the
worked examples, and adding a type is what the
[no-raw-commands rule](../../../../CONTRIBUTING.md) asks for over reaching for
this escape hatch. Do not use `ToolRun` for a check whose exit code is a
verdict — that is a cacheable gate, so it is a [NodeTest](node-test.md),
`Vitest`, or a lint target. Do not use it for a long-lived watch process — that
is [Dev](dev.md).

## Attributes

| Name                | Type                     | Default     | Description                                                                                   |
| ------------------- | ------------------------ | ----------- | --------------------------------------------------------------------------------------------- |
| `command`           | `string`                 | required    | The executable. Spawned directly, not through a shell.                                        |
| `args`              | `Array<string>`          | required    | Arguments passed after the executable.                                                        |
| `inputs`            | `Array<Input.Declared>`  | required    | Input declarations digested as key material and as ordering.                                  |
| `deps`              | `Array<Target.Target>`   | required    | Dependency targets. A `run` target may depend on a check that must pass first.                |
| `secrets`           | `Array<Secret>`          | `[]`        | Environment variables the substituting proxy fills at spawn. Never enter the plan or the key. |
| `env`               | `Record<string, string>` | `{}`        | Non-secret environment merged over the confined base.                                         |
| `expectedExitCodes` | `Array<number>`          | `[0]`       | Exit codes treated as success.                                                                |
| `timeoutMs`         | `number`                 | ten minutes | Overrides the shared exec runner's process-lifetime bound.                                    |
| `cwd`               | `string`                 | `"."`       | Workspace-relative directory the command runs in.                                             |

## Command

```
<command> <args...>
```

Spawned once, through the irreversible exec action.

## Inputs

Collected from the attrs: every declaration in `inputs`.

## Secrets

A credential is declared with `Smithers.Secret("ENV_NAME")`, never as a literal
in `env`. The value is read from the named environment variable at execution
time and substituted into the child process by the proxy, so it appears in
neither the recorded plan nor the content key. A `ToolRun` that a coding agent
runs still receives the credential; a plan a human reads never shows it. See
[Secret](../../../../targets/src/Secret.ts).

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                     |
| --------- | ----------------------------------- |
| Kinds     | `run`                               |
| Verb gate | `run` only                          |
| Cacheable | Never                               |
| Executes  | Yes, through `ExecIrreversibleLive` |

## Why it is gated and never cached

`ToolRun` runs through the irreversible exec action, the same one the release
targets use. Three properties follow, and each is deliberate:

- **Never cacheable.** A side effect has no output to verify a cache entry
  against, and re-running is not free. `cache` is fixed to `false`; there is no
  attribute to turn it on.
- **Never retried or replayed blindly.** The irreversible tier tells the engine
  this operation must not be re-dispatched on a transient failure, nor executed
  by any verification or cache-population path.
- **`run` verb gate.** The target refuses to enter a `build`, `test`, `lint`, or
  `docs` graph, including as a transitive dependency. A `ci` run cannot pull a
  deploy or a job launch along with it. Run it on its own, on purpose.

## Notes

`env` is key material, so a value that varies per host or per run re-keys the
target every time. Put credentials in `secrets`, not `env`.

The command is spawned directly, never through a shell, so shell features
(globs, pipes, `&&`, variable expansion) do not apply. Pass a real argv.

## See also

- [ToolBuild](tool-build.md) for a cached build that produces file outputs
- [Dev](dev.md) for a long-lived process
- [NodeTest](node-test.md) for a gate whose exit code is a verdict
- [Writing targets](../../extending/writing-targets.md)
