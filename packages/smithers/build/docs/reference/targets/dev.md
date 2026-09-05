---
title: "Dev"
description: "Runs a long-lived development or watch command under the run verb."
---

Runs a long-lived development or watch command.

```ts
import { Smithers } from "@smthrs/targets"

export const dev = Smithers.Dev({
  command: "pnpm",
  args: ["exec", "vite", "dev"],
  inputs: [Smithers.glob("src/**/*.ts")],
  deps: [lib],
  cwd: "packages/web",
  readyWhen: null
})
```

## Attributes

| Name        | Type                    | Default  | Description                                                                           |
| ----------- | ----------------------- | -------- | ------------------------------------------------------------------------------------- |
| `command`   | `string`                | required | The executable. Spawned directly, not through a shell.                                |
| `args`      | `Array<string>`         | required | Arguments passed after the executable.                                                |
| `inputs`    | `Array<Input.Declared>` | required | Input declarations digested as startup key material.                                  |
| `deps`      | `Array<Target.Target>`  | required | Dependency targets.                                                                   |
| `cwd`       | `string`                | required | Workspace-relative directory the command runs in. **No default.**                     |
| `readyWhen` | `string \| null`        | required | A readiness marker. Key material only; the shared exec action has no readiness probe. |

`Dev` is the one tool-running target whose `cwd` has no constructor default. Pass
it explicitly.

## Command

```text
<command> <args...>
```

The spawn is a pass-through. The node succeeds when the process exits cleanly,
and interrupting the fiber kills it.

## Inputs

Collected from the attrs: every declaration in `inputs`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Key material

`capabilities` for this target is `["proc:spawn"]`, not the default
`["fs:read", "proc:spawn"]`.

`readyWhen` is key material and nothing else. Nothing reads it at execution time.

## Status

|           |                                                        |
| --------- | ------------------------------------------------------ |
| Kinds     | `run`                                                  |
| Cacheable | Never; the process stays live                          |
| Executes  | Yes, through `ExecLive`, as a `run` root or dependency |

Invoke it explicitly with `smithers-build run <label>`. It holds its concurrency slot
until the process exits. Do not put a `Dev` target in a dependency chain that
`build`, `test`, `lint`, or `ci` reaches.

## See also

- [VitestWatch](vitest-watch.md) for the Vitest-specific form
- [ToolBuild](tool-build.md) for a command that terminates
- [Running targets](../../workspace/running-targets.md)
