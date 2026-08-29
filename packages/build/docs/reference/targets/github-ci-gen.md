# GithubCiGen

Generates the GitHub Actions CI workflow from declared jobs. The workflow is a
generated root file on the same terms as `tsconfig.json`: BUILD.ts is the only
description of the pipeline, `write` renders it, and `check` — the default —
fails on drift. By contrast, `pnpm-workspace.yaml` is a hand-written planner
input because pnpm may add settings outside the target schema.

**A job declares what it requires and which targets it runs. Nothing in the
declaration is a command.** There is no `run`, no `uses`, no `command`, and no
`args` anywhere in the attrs. Every argv the generated file carries is derived:
the install from [`PackageManager.install`](install.md), the interpreter version
from the declared runtime, the Rust install from the declared toolchain, and
each pipeline step from the CLI verb and target pattern it names. A gate that is
not a target cannot reach the pipeline; it has to become a target first, in the
package that owns it.

```ts
import { Smithers } from "@smthrs/targets"

export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

export const ci = Smithers.GithubCiGen({
  packageManager,
  workflowName: "CI",
  pushBranches: ["main"],
  pullRequest: true,
  workflowDispatch: true,
  cancelInProgress: true,
  jobs: [
    {
      id: "test",
      runsOn: "ubuntu-latest",
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [Smithers.CiToolchain.Node({ runtime, release: "22.19.0" })]
      }),
      steps: [
        { name: "Workspace targets", verb: Smithers.Verb.Ci, pattern: "//packages/...", parallelism: 2 },
        { name: "Script gates", verb: Smithers.Verb.Test, pattern: "//scripts/..." }
      ]
    }
  ],
  requiredJobs: ["test"],
  gates: [
    { name: "documentation parity", verb: Smithers.Verb.Docs, pattern: "//packages/...", job: "test" }
  ],
  output: ".github/workflows/ci.yml",
  mode: "check"
})
```

## Package mode: `Github.Workflow`

`PACKAGE.ts` workspaces declare a file set rather than the BUILD-era job table.
`Github.Workflow` describes one workflow, `Github.Setup` describes the shared
composite setup action used by target-derived jobs, and `Github.CiGen` owns the
generated files:

```ts
const publish = Smithers.Github.Workflow({
  name: "publish-sdk",
  on: {
    push: { branches: ["main"] },
    workflowDispatch: {
      inputs: {
        force_publish: {
          description: "Publish even when unchanged",
          required: true,
          default: false,
          type: "boolean"
        }
      }
    }
  },
  env: { CARGO_TERM_COLOR: "always" },
  environment: "prod",
  jobName: "Publish SDK",
  runsOn: "blacksmith-4vcpu-ubuntu-2404",
  steps: [
    { uses: "actions/checkout@v4", with: { "fetch-depth": "0" } },
    {
      name: "Publish",
      if: "inputs.force_publish",
      run: ["cargo test -p sdk", "cargo publish -p sdk"],
      env: { CARGO_REGISTRY_TOKEN: "${{ secrets.CARGO_REGISTRY_TOKEN }}" }
    }
  ]
})

const github = Smithers.Github.CiGen({
  workflows: [publish],
  changes: ["workflows/**"]
})
```

The package-mode workflow attributes are:

| Name          | Type                         | Default           | Description                                                                                                                                                 |
| ------------- | ---------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | `string`                     | required          | Workflow display name, job id for a raw-step job, and the stem of `workflows/<name>.yml`.                                                                   |
| `on`          | `On`                         | required          | Trigger table described below.                                                                                                                              |
| `setup`       | `Github.Setup`               | optional          | Shared composite action inserted into target-derived jobs after checkout.                                                                                   |
| `affected`    | `boolean`                    | optional          | Gives target-derived jobs full checkout history and passes the merge base to the CLI.                                                                       |
| `run`         | `Array<Target>`              | `[]`              | Targets rendered as generated jobs. Each job checks out the repository, invokes `setup` when declared, and runs its target label through the workspace CLI. |
| `steps`       | `Array<Step>`                | optional          | Raw ordered steps rendered into a job named from the workflow. The generator inserts nothing into this list.                                                |
| `env`         | `Record<string, string>`     | optional          | Workflow-level environment.                                                                                                                                 |
| `permissions` | `Record<string, Permission>` | optional          | Workflow token permissions; each value is `read`, `write`, or `none`.                                                                                       |
| `concurrency` | `Concurrency`                | optional          | `group` plus `cancelInProgress`; the latter accepts a boolean or an event name.                                                                             |
| `environment` | `string`                     | optional          | Deployment environment on every generated job.                                                                                                              |
| `condition`   | `string`                     | optional          | Raw job-level `if:` condition on every generated job.                                                                                                       |
| `jobName`     | `string`                     | optional          | Operator-facing name on every generated job.                                                                                                                |
| `runsOn`      | `string`                     | `"ubuntu-latest"` | Runner label on every generated job.                                                                                                                        |

`steps` may replace `run` or accompany it. When both are present, the raw-step
job is emitted first, followed by the target-derived jobs in `run` order. A raw
step list must declare its own checkout and tool setup; `setup` remains the
prelude for target-derived jobs only. A workflow using `setup` also makes
`actions/setup/action.yml`, so the owning `Github.CiGen` write set must include
`actions/setup/**` beside `workflows/**`. Check and write refuse a rendered file
outside that set.

### Package-mode triggers

| Name               | Type                                           | Description                                                                        |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pullRequest`      | `boolean \| { branches?, types? }`             | A simple pull-request trigger or filters using GitHub pull-request activity names. |
| `issues`           | `{ types?: Array<IssueActivity> }`             | Issue activity filters.                                                            |
| `push`             | `{ branches: Array<string> }`                  | Push branches.                                                                     |
| `schedule`         | `Array<string>`                                | Five-field cron expressions, rendered as GitHub's `schedule: [{ cron }]` form.     |
| `release`          | `Array<ReleaseActivity>`                       | GitHub release activity names.                                                     |
| `workflowDispatch` | `boolean \| { inputs: Record<string, Input> }` | A manual trigger, optionally with typed inputs.                                    |

A dispatch input accepts `description`, `required`, `default`, and a required
`type` (`boolean`, `choice`, `environment`, or `string`). A `choice` input may
also declare `options`.

### Raw step

| Name               | Type                      | Description                                                                             |
| ------------------ | ------------------------- | --------------------------------------------------------------------------------------- |
| `name`             | `string`                  | Optional operator-facing step name.                                                     |
| `id`               | `string`                  | Optional step id.                                                                       |
| `uses`             | `string`                  | Action reference. Exclusive with `run`.                                                 |
| `with`             | `Record<string, string>`  | Action inputs.                                                                          |
| `run`              | `string \| Array<string>` | Shell script. Array entries are joined with newlines and rendered as one literal block. |
| `env`              | `Record<string, string>`  | Step environment.                                                                       |
| `if`               | `string`                  | Raw step condition.                                                                     |
| `shell`            | `string`                  | Shell for a `run` step.                                                                 |
| `workingDirectory` | `string`                  | Working directory for a `run` step, rendered as GitHub's `working-directory`.           |

The raw form exists to migrate an established GitHub job without changing its
step structure or scripts. It is a package-mode escape hatch; the BUILD-era
`GithubCiGen` contract below still admits only target invocations and derives
every command.

## Modes

| Mode    | Behavior                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| `check` | Default. Renders declared jobs and byte-compares the result with the checked-in workflow. It never writes. |
| `write` | Explicit generation. Validates and writes the rendered workflow.                                           |

The `lint` form maps `write` to `check`. `smthrs ci` plans lint first, so CI is
also non-mutating even if a target explicitly declares write mode. Only an
explicit `smthrs build` of a `mode: "write"` target generates a file.

## Attributes

| Name               | Type                            | Default                      | Description                                                                                                                                           |
| ------------------ | ------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowName`     | `string`                        | `"CI"`                       | Generated workflow name.                                                                                                                              |
| `pushBranches`     | `Array<string>`                 | `["main"]`                   | Generated push branches.                                                                                                                              |
| `pullRequest`      | `boolean`                       | `true`                       | Generated pull-request trigger.                                                                                                                       |
| `workflowDispatch` | `boolean`                       | `true`                       | Generated manual trigger.                                                                                                                             |
| `cancelInProgress` | `boolean`                       | `true`                       | Generated concurrency policy.                                                                                                                         |
| `packageManager`   | `PackageManager.PackageManager` | required                     | The declared package manager. Every job installs with it and runs the smthrs binary through it, so a workspace that switches managers is regenerated. |
| `cacheUrlSecret`   | `Secret.Secret`                 | optional                     | The declared secret supplying the remote-cache endpoint override. Every generated target step reads the repository secret of the same name.           |
| `cacheTokenSecret` | `Secret.Secret`                 | optional                     | The declared secret supplying the remote-cache bearer token.                                                                                          |
| `jobs`             | `Array<Job>`                    | `[]`                         | Jobs rendered by `write` and `check`; the render refuses an empty list.                                                                               |
| `gates`            | `Array<Gate>`                   | `[]`                         | Target invocations the pipeline must still perform, optionally in one named job. Checked structurally against the declared steps, never against text. |
| `requiredJobs`     | `Array<string>`                 | `[]`                         | Job ids the workflow must define, in every mode.                                                                                                      |
| `output`           | `string`                        | `".github/workflows/ci.yml"` | Workspace-relative workflow path.                                                                                                                     |
| `mode`             | `"check" \| "write"`            | `"check"`                    | Output handling described above.                                                                                                                      |

### Job

| Name              | Type                    | Default  | Description                                                                                 |
| ----------------- | ----------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `id`              | `string`                | required | GitHub job id: a letter or `_`, then letters, digits, `-`, `_`.                             |
| `name`            | `string`                | optional | Operator-facing job name.                                                                   |
| `runsOn`          | `string`                | required | One runner label, or a label set `[a, b]`.                                                  |
| `timeoutMinutes`  | `number`                | optional | A whole number from 1 to 360.                                                               |
| `continueOnError` | `boolean`               | optional | Advisory lane.                                                                              |
| `toolchain`       | `CiToolchain.Toolchain` | required | What the runner must provide before the first target runs. See [CiToolchain](#citoolchain). |
| `steps`           | `Array<TargetStep>`     | required | The target invocations this job performs. A job with none is refused.                       |

### TargetStep

| Name          | Type                | Default            | Description                                                                                                          |
| ------------- | ------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `name`        | `string`            | optional           | Operator-facing step name.                                                                                           |
| `verb`        | `Verb.PipelineVerb` | required           | `Verb.Build`, `Verb.Test`, `Verb.Lint`, `Verb.Docs`, or `Verb.Ci` — the aggregate that plans every kind in one call. |
| `pattern`     | `string`            | required           | `//...`, `//pkg/...`, `//pkg`, `//pkg:target`, or `//:target`. Rendered as one single-quoted shell word.             |
| `parallelism` | `number`            | the CLI's own size | `--jobs` bound, 1 to 256.                                                                                            |

`Verb` defines no `run` value at all. Run targets may start long-lived
development services or mutate the source tree, so a pipeline that runs them is
a declaration that cannot be written.

### Gate

| Name      | Type        | Default  | Description                                                      |
| --------- | ----------- | -------- | ---------------------------------------------------------------- |
| `name`    | `string`    | required | Operator-facing name, used in the failure message.               |
| `verb`    | `Verb.Verb` | required | The verb the invocation must run under. `Verb.Ci` satisfies any. |
| `pattern` | `string`    | required | The exact pattern it must run over.                              |
| `job`     | `string`    | optional | The job id the invocation must appear in.                        |

A gate is a claim about coverage that outlives the job list: "the docs verb
still runs over the packages". It is checked against the declared steps, so it
cannot be satisfied by a comment that happens to contain the right words, and a
wider pattern does not satisfy a narrower gate — a different pattern is a
different claim.

## CiToolchain

`CiToolchain.Needs({ … })` declares what a job requires. The generator turns each
requirement into steps, in the order a runner needs them: checkout, workflow
lint, package-manager setup, interpreters, install, language toolchains, runner
assertions, then the job's target steps, then artifact collection.

| Name           | Type                  | Default  | Renders                                                                                    |
| -------------- | --------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `submodules`   | `boolean`             | `false`  | `actions/checkout@v4` with `submodules: recursive`.                                        |
| `install`      | `boolean`             | `true`   | The manager's setup action and its frozen, script-free install.                            |
| `runtimes`     | `Array<RuntimeSetup>` | `[]`     | `CiToolchain.Node({ runtime, release })` / `CiToolchain.Bun({ runtime, release })`.        |
| `rust`         | `RustSetup`           | optional | `CiToolchain.Rust({ toolchain })` — `rustup toolchain install`, plus the cache by default. |
| `jj`           | `JjSetup`             | optional | `CiToolchain.Jj({ release })` — the pinned jj-cli, and a colocated repository.             |
| `browser`      | `SystemBrowser`       | optional | `CiToolchain.Browser({ executable, reason })` — asserts the runner image ships it.         |
| `workflowLint` | `WorkflowLint`        | optional | `CiToolchain.Actionlint({ release, workflows })`.                                          |
| `artifacts`    | `ArtifactUpload`      | optional | `CiToolchain.Artifacts({ artifact, sources })` — collect and upload.                       |

Every version a runner downloads is enumerated by the schema, for the reason
`Runtime.NodeVersion` is enumerated: the set of versions a workspace may pin is
reviewed, not free text. A pin that names a release the publisher does not have
is a CI failure at 03:00; a pin outside the enumeration is a type error at the
call site. Action references are constants of the implementation, never attrs —
an action reference is an argv by another name.

## Generation guarantees

### What generation refuses

Every refusal is a throw at plan time, before any file is written.

- an empty job list, and a job that runs no targets;
- a job that runs targets while declaring `install: false`, which would have no
  workspace binary to run them with;
- any declared `requiredJobs` id the render does not define;
- a declared gate no job performs;
- a `pattern` outside the CLI's label grammar. The supported forms are exactly
  `//...`, `//pkg/...`, `//pkg`, `//pkg:target`, and `//:target`, with
  components of `[A-Za-z0-9_][A-Za-z0-9._-]*`. That rejects `*` and other globs,
  option-like values such as `--help` (which would make a step a usage message
  exiting 0), `..` traversal, empty components, and more than one colon;
- a `parallelism` outside 1..256, or one that is not a whole number;
- a `timeoutMinutes` outside 1..360, or one that is not a whole number. Zero and
  negative values are rejected by the runner and larger ones are silently
  capped, so both render a job that does not enforce what it declares. The attrs
  schema bounds it and `render` checks it again;
- duplicate or malformed job ids. YAML keeps the last of a duplicated mapping
  key, so a gate could otherwise match a job that never runs;
- a declared path or diagnostic a shell would reinterpret: a browser executable
  or artifact source carrying a quote, `$`, backtick, `;`, `&`, `|`, `(`, `)`,
  `<`, `>`, whitespace, or `..`;
- a control character in a rendered value, such as the carriage return of a
  CRLF value, which the shell cannot run.

### Quoting

Rendered scalars are quoted unless YAML reads them back as exactly the declared
string. Every attribute is declared a `string`, so a value that would resolve to
a boolean (`true`, `yes`, `off`), null (`null`, `~`), a number (`22`, `1e5`,
`0x1A`, `0777`, `12:30`), or a timestamp (`2026-08-14`) is quoted — a workflow
named `true` would otherwise become the boolean `true`, and a branch `null` an
empty entry. The target applies to KEYS too: a job id and a `with:`/`env:` name
are declared strings as much as values are, so `no:`, `ON:`, and `Y:` are
quoted rather than left to resolve to booleans. Unambiguous values and keys keep
their unquoted form byte for byte.

`runs-on` is the one attribute whose declared string may be a YAML sequence. A
label set (`[self-hosted, linux]`) stays a sequence, and each label is judged on
its own terms, so `[self-hosted, null]` renders `[self-hosted, "null"]` rather
than silently losing a label. A value that opens a flow collection without being
that label set — `[self-hosted, my label]`, `{group: g, labels: [x]}`, `[]` — is
**refused**, because quoting it would produce a single label no runner carries
and a job that never picks up. An expression (`${{ matrix.os }}`) is a quoted
scalar, which GitHub still evaluates.

### No step conditions

The renderer has no way to emit a job or step `if:` at all, so every rendered
step runs unconditionally and nobody has to adjudicate in review which
conditions are load-bearing. Artifact collection is best-effort by construction
instead: the copies tolerate an empty source and the upload declares
`if-no-files-found: ignore`, which gives the same result on a green run.

### The workspace binary

Every target step runs the workspace binary the declared install put in the
tree — `pnpm exec smthrs …`, `bun x smthrs …` — so the CLI that runs is the one
the lockfile pinned, never a fetched one. The pattern is rendered as one
single-quoted shell word, a literal in every default GitHub Actions shell
(`bash` on Linux and macOS, `pwsh` on Windows), so the runner cannot
glob-expand or re-split it.

In check mode the output is a declared input and the target is cacheable.
Write mode is non-cacheable.

## Channels and status

|          |                                                          |
| -------- | -------------------------------------------------------- |
| Kinds    | `build`, `lint`                                          |
| Success  | `Schema.Void`                                            |
| Error    | `WriteFileError \| DriftError`                           |
| Executes | Yes. The executor provides write and byte-check actions. |

## See also

- [NodeTest](node-test.md) and [NodeBinary](node-binary.md) — the targets a
  script gate becomes
- [CargoLint / CargoTest](cargo.md) — the targets a Rust gate becomes
- [Writing BUILD files](../../workspace/writing-build-files.md#build-files-declare-targets-never-commands)
- [Running targets](../../workspace/running-targets.md)
- [Remote caching](../../workspace/remote-caching.md)
