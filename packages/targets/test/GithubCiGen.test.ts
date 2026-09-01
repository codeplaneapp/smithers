/**
 * The generated CI workflow: what a BUILD.ts file may declare, and what the
 * generator renders from it.
 *
 * The load-bearing assertion in this file is the first one. Every other test
 * here checks that the render is correct; that one checks that there is no way
 * to declare a command at all, which is the property the whole module exists
 * for.
 */
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as CiToolchain from "../src/CiToolchain.ts"
import { artifactSteps, Attrs, Gate, GithubCiGen, Job, MatrixRow, render, TargetStep } from "../src/GithubCiGen.ts"
import { parseWorkflow as parseStrictWorkflow } from "../src/GithubWorkflow.ts"
import * as RustToolchain from "../src/RustToolchain.ts"
import { Secret } from "../src/Secret.ts"
import * as Target from "../src/Target.ts"
import * as Verb from "../src/Verb.ts"
import { packageManager, runtime } from "./toolchain.ts"

/** Most focused fixtures omit trigger prose; supply the smallest real trigger. */
const parseWorkflow = (source: string): ReturnType<typeof parseStrictWorkflow> =>
  parseStrictWorkflow(/^on\s*:/m.test(source) ? source : `on: workflow_dispatch\n${source}`)

const node = CiToolchain.Node({ runtime, release: "22.19.0" })
const bareNode = CiToolchain.Node({ runtime, release: "22.19.0", cachePackageStore: false })
const rust = CiToolchain.Rust({ toolchain: RustToolchain.Pinned({}) })

/** The golden pipeline `write` mode renders. */
const goldenAttrs = {
  packageManager,
  workflowName: "CI",
  pushBranches: ["main"],
  pullRequest: true,
  workflowDispatch: true,
  cancelInProgress: true,
  requiredJobs: [],
  gates: [
    { name: "workspace graph", verb: Verb.Test, pattern: "//packages/...", job: "test" },
    { name: "browser contract", verb: Verb.Test, pattern: "//scripts:browserContract", job: "browser" }
  ],
  jobs: [
    {
      id: "test",
      name: "workspace graph",
      runsOn: "ubuntu-latest",
      toolchain: CiToolchain.Needs({
        runtimes: [node],
        jj: CiToolchain.Jj({ release: "0.39.0" }),
        workflowLint: CiToolchain.Actionlint({ release: "1.7.11", workflows: [".github/workflows/ci.yml"] })
      }),
      steps: [
        { name: "Workspace targets", verb: Verb.Ci, pattern: "//packages/...", parallelism: 2 },
        { name: "Script gates", verb: Verb.Test, pattern: "//scripts/..." }
      ]
    },
    {
      id: "browser",
      runsOn: "ubuntu-latest",
      timeoutMinutes: 10,
      toolchain: CiToolchain.Needs({ runtimes: [node] }),
      steps: [{ name: "Browser bundle guard", verb: Verb.Test, pattern: "//scripts:browserContract" }]
    },
    {
      id: "rust",
      runsOn: "ubuntu-latest",
      continueOnError: false,
      toolchain: CiToolchain.Needs({ submodules: true, runtimes: [bareNode], rust }),
      steps: [{ name: "Cargo gates", verb: Verb.Lint, pattern: "//crates/flows-jj" }]
    }
  ],
  output: ".github/workflows/generated.yml",
  mode: "write" as const
}

const golden = `name: CI
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    name: workspace graph
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Validate GitHub Actions workflows
        uses: docker://rhysd/actionlint:1.7.11
        with:
          args: ".github/workflows/ci.yml"
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v4
        with:
          node-version: 22.19.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - name: Install jj
        uses: taiki-e/install-action@v2
        with:
          tool: jj-cli@0.39.0
      - name: Initialize colocated jj repository
        run: jj git init --colocate
      - name: Workspace targets
        run: pnpm exec smithers-build ci '//packages/...' --jobs 2
      - name: Script gates
        run: pnpm exec smithers-build test '//scripts/...'
  browser:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v4
        with:
          node-version: 22.19.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - name: Browser bundle guard
        run: pnpm exec smithers-build test '//scripts:browserContract'
  rust:
    runs-on: ubuntu-latest
    continue-on-error: false
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v4
        with:
          node-version: 22.19.0
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - name: Install pinned Rust toolchain
        run: rustup toolchain install
      - uses: Swatinem/rust-cache@v2
      - name: Cargo gates
        run: pnpm exec smithers-build lint '//crates/flows-jj'
`

const attrsOf = (input: unknown): never => GithubCiGen(input as typeof goldenAttrs)[Target.TargetTypeId].attrs as never

/** Every field name reachable from a schema, following struct and union shapes. */
const fieldNames = (schema: unknown, seen = new Set<unknown>()): ReadonlyArray<string> => {
  if (schema === null || typeof schema !== "object" || seen.has(schema)) return []
  seen.add(schema)
  const names: Array<string> = []
  const fields = (schema as { readonly fields?: Record<string, unknown> }).fields
  if (fields !== undefined) {
    for (const [name, field] of Object.entries(fields)) {
      names.push(name, ...fieldNames(field, seen))
    }
  }
  for (const key of ["members", "schema", "from", "to", "item"]) {
    const nested = (schema as Record<string, unknown>)[key]
    if (Array.isArray(nested)) { for (const member of nested) names.push(...fieldNames(member, seen)) }
    else if (nested !== undefined) names.push(...fieldNames(nested, seen))
  }
  return names
}

describe("the declaration surface", () => {
  /**
   * Will's ruling, 2026-08-19: "We should never ever ever ever ever in a
   * BUILD.ts file hardcode bash commands like this to run node scripts or even
   * run node --test. It needs to be a real target."
   *
   * The rule is enforced by the schema, not by review. A step declares a verb
   * and a target pattern; there is no `run`, no `uses`, no `command`, no
   * `script`, and no `args` anywhere in the attrs, so a gate that is not a
   * target cannot reach the pipeline at all. Adding one back would fail here.
   */
  it("admits no free-form command anywhere in the attrs", () => {
    const names = new Set(fieldNames(Attrs))
    expect(
      [...names].filter((name) =>
        ["run", "uses", "command", "commands", "script", "shell", "args", "argv", "install", "entrypoint"]
          .includes(name)
      )
    ).toEqual([])
    // The two things a step CAN say, and nothing else.
    expect(Object.keys(TargetStep.fields).sort()).toEqual(["name", "parallelism", "pattern", "verb"])
    // A gate is a target invocation too, not a command to match in the text.
    expect(Object.keys(Gate.fields).sort()).toEqual(["job", "name", "pattern", "verb"])
    // A job says what it requires and what it runs.
    expect(Object.keys(Job.fields).sort())
      .toEqual(["continueOnError", "id", "matrix", "name", "runsOn", "steps", "timeoutMinutes", "toolchain"])
  })

  it("refuses a step whose verb is not a CLI verb value", () => {
    expect(() =>
      GithubCiGen({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "test",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ runtimes: [node] }),
          steps: [{ verb: { name: "curl" }, pattern: "//..." }]
        }]
      } as never)
    ).toThrow()
  })

  it("has no value for the manual run verb at all", () => {
    // `run` targets include watchers, development servers, and source-tree
    // scaffolds. The CLI exposes them for explicit use, not for generated CI,
    // so the module exports no value a BUILD.ts file could name.
    expect(Object.keys(Verb).filter((name) => name.toLowerCase() === "run")).toEqual([])
    expect(Verb.all.map(Verb.kind)).toEqual(["build", "test", "lint", "docs"])
    expect(Verb.isPipelineVerb({ name: "run" })).toBe(false)
    expect(Verb.isPipelineVerb(Verb.Ci)).toBe(true)
    expect(Verb.isVerb(Verb.Ci)).toBe(false)
  })
})

describe("render", () => {
  it("matches the golden multi-job pipeline byte for byte", () => {
    expect(render(attrsOf(goldenAttrs))).toBe(golden)
  })

  it("renders output the workflow reader can read back", () => {
    const workflow = parseWorkflow(golden)
    expect(workflow.jobs.map((job) => job.id)).toEqual(["test", "browser", "rust"])
  })

  it("derives the install from the declared package manager, never from an attr", () => {
    expect(golden).toContain("      - run: pnpm install --frozen-lockfile --ignore-scripts\n")
    // Every job that runs a target installs first, because the workspace binary
    // is what runs the target.
    for (const job of parseWorkflow(golden).jobs) {
      const commands = job.steps.map((step) => step.run ?? step.uses ?? "")
      expect(commands.findIndex((command) => command.startsWith("pnpm install --frozen-lockfile")))
        .toBeLessThan(commands.findIndex((command) => command.startsWith("pnpm exec smithers-build")))
    }
  })

  it("runs the workspace-pinned CLI the install put in the tree, never a fetched one", () => {
    expect(render(attrsOf(goldenAttrs))).not.toContain("dlx")
  })

  it("follows the declared package manager into its own workspace runner", () => {
    const bunRuntime = { name: "bun" as const, version: ">=1.3.0" as const, executable: "bun" }
    const rendered = render(attrsOf({
      ...goldenAttrs,
      packageManager: { name: "bun", version: ">=1.3.0", executable: "bun", runtime: bunRuntime }
    }))
    expect(rendered).toContain("      - run: bun install --frozen-lockfile --ignore-scripts\n")
    expect(rendered).toContain("        run: bun x smithers-build test '//scripts/...'\n")
    // Bun installs itself; a second manager-setup action would install the same
    // program twice.
    expect(rendered).not.toContain("pnpm/action-setup")
  })

  it("refuses to render a pipeline that drops a declared gate", () => {
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [...goldenAttrs.gates, { name: "wasm reproducibility", verb: Verb.Test, pattern: "//crates/..." }]
      }))
    ).toThrow(/does not run wasm reproducibility/)
    // A gate pinned to the wrong job is not satisfied by the right invocation
    // in another job.
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [{ name: "browser contract", verb: Verb.Test, pattern: "//scripts:browserContract", job: "rust" }]
      }))
    ).toThrow(/does not run browser contract/)
  })

  it("counts the aggregate verb as every verb it plans", () => {
    // `smithers-build ci` over //packages/... satisfies a docs gate on the same pattern,
    // because the aggregate command plans the docs verb too.
    expect(
      render(attrsOf({
        ...goldenAttrs,
        gates: [{ name: "documentation parity", verb: Verb.Docs, pattern: "//packages/...", job: "test" }]
      }))
    ).toContain("pnpm exec smithers-build ci '//packages/...'")
    // A wider pattern is a different claim and does not satisfy a narrower gate.
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [{ name: "everything", verb: Verb.Test, pattern: "//..." }]
      }))
    ).toThrow(/does not run everything/)
  })

  it("refuses to render with no jobs declared", () => {
    expect(() => render(attrsOf({ ...goldenAttrs, jobs: [], gates: [] }))).toThrow(/at least one declared job/)
  })

  it("refuses to render an inert workflow with no trigger", () => {
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        pushBranches: [],
        pullRequest: false,
        workflowDispatch: false
      }))
    ).toThrow(/at least one workflow trigger/)
  })

  it("refuses a job that runs targets without installing the workspace", () => {
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "test",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ install: false, runtimes: [node] }),
          steps: [{ verb: Verb.Test, pattern: "//..." }]
        }]
      }))
    ).toThrow(/declares install: false/)
  })

  it("refuses to render a workflow missing a declared required job", () => {
    expect(() => render(attrsOf({ ...goldenAttrs, requiredJobs: ["test", "wasm-repro"] })))
      .toThrow(/missing required jobs: wasm-repro/)
  })

  it("refuses duplicate job ids rather than emitting a shadowed job", () => {
    expect(() => render(attrsOf({ ...goldenAttrs, jobs: [...goldenAttrs.jobs, goldenAttrs.jobs[2]!] })))
      .toThrow(/duplicate job id "rust"/)
  })

  it("refuses job shapes GitHub Actions rejects", () => {
    const withJobs = (jobs: unknown): never => attrsOf({ ...goldenAttrs, jobs, gates: [] })
    const toolchain = CiToolchain.Needs({ runtimes: [node] })
    const step = { verb: Verb.Test, pattern: "//..." }
    expect(() => render(withJobs([{ id: "test", runsOn: "ubuntu-latest", toolchain, steps: [] }])))
      .toThrow(/runs no targets/)
    expect(() => render(withJobs([{ id: "a b", runsOn: "ubuntu-latest", toolchain, steps: [step] }])))
      .toThrow(/is not a valid job id/)
  })

  it("refuses a timeout GitHub Actions does not run", () => {
    const withTimeout = (timeoutMinutes: number): unknown => ({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "test",
        runsOn: "ubuntu-latest",
        timeoutMinutes,
        toolchain: CiToolchain.Needs({ runtimes: [node] }),
        steps: [{ verb: Verb.Test, pattern: "//..." }]
      }]
    })
    // The schema rejects an out-of-range value at declaration time.
    for (const timeout of [0, -1, 361, 1440, 1.5]) {
      expect(() => GithubCiGen(withTimeout(timeout) as typeof goldenAttrs)).toThrow()
    }
    // `render` is exported, so it checks again rather than trusting its input.
    const constructed = attrsOf(withTimeout(10)) as unknown as Record<string, unknown>
    for (const timeout of [0, -1, 361, 1.5]) {
      expect(() =>
        render({
          ...constructed,
          jobs: [{
            id: "test",
            runsOn: "ubuntu-latest",
            timeoutMinutes: timeout,
            toolchain: CiToolchain.Needs({ runtimes: [node] }),
            steps: [{ verb: Verb.Test, pattern: "//..." }]
          }]
        } as never)
      ).toThrow(/timeout-minutes/)
    }
    // The boundaries themselves render.
    for (const timeout of [1, 360]) {
      expect(render(attrsOf(withTimeout(timeout)))).toContain(`    timeout-minutes: ${timeout}\n`)
    }
  })

  it("quotes values that would otherwise change the shape of the YAML", () => {
    const rendered = render(attrsOf({
      ...goldenAttrs,
      workflowName: "CI: main",
      pushBranches: ["main", "release: next"],
      jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, runsOn: "${{ matrix.os }}" })
    }))
    expect(rendered).toContain("name: \"CI: main\"\n")
    expect(rendered).toContain("    branches: [main, \"release: next\"]\n")
    expect(rendered).toContain("    runs-on: \"${{ matrix.os }}\"\n")
    expect(parseWorkflow(rendered).name).toBe("CI: main")
    // A label set is a YAML sequence GitHub reads, so it is not quoted into one
    // nonexistent label.
    expect(
      render(attrsOf({
        ...goldenAttrs,
        jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, runsOn: "[self-hosted, linux]" })
      }))
    ).toContain("    runs-on: [self-hosted, linux]\n")
  })

  it("keeps every declared string a YAML string", () => {
    const ambiguous = ["true", "false", "null", "yes", "no", "on", "off", "y", "n", "~", "NULL", "Off"]
    for (const value of ambiguous) {
      const rendered = render(attrsOf({ ...goldenAttrs, gates: [], workflowName: value }))
      expect({ value, line: rendered.split("\n")[0] }).toEqual({ value, line: `name: ${JSON.stringify(value)}` })
    }
    for (const value of ["22", "1.5", "1e5", "0x1A", "0777", "12:30", "2026-08-14", ".inf", "-1"]) {
      const rendered = render(attrsOf({
        ...goldenAttrs,
        gates: [],
        pushBranches: [value],
        jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, name: value })
      }))
      expect({ value, rendered: rendered.includes(`    branches: [${JSON.stringify(value)}]\n`) })
        .toEqual({ value, rendered: true })
      expect({ value, rendered: rendered.includes(`    name: ${JSON.stringify(value)}\n`) })
        .toEqual({ value, rendered: true })
    }
    // A runner that resolves to a boolean is a `runs-on` GitHub rejects, and a
    // reserved label inside a label SET drops silently out of the set.
    expect(
      render(attrsOf({
        ...goldenAttrs,
        jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, runsOn: "false" })
      }))
    ).toContain("    runs-on: \"false\"\n")
    expect(
      render(attrsOf({
        ...goldenAttrs,
        jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, runsOn: "[self-hosted, null]" })
      }))
    ).toContain("    runs-on: [self-hosted, \"null\"]\n")
  })

  it("refuses a runs-on collection it cannot render as the label set it declares", () => {
    const withRunner = (runsOn: string): never =>
      attrsOf({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "test",
          runsOn,
          toolchain: CiToolchain.Needs({ runtimes: [node] }),
          steps: [{ verb: Verb.Test, pattern: "//..." }]
        }]
      })
    for (const runsOn of ["[self-hosted, my label]", "{group: ubuntu, labels: [x]}", "[self-hosted,]", "[]"]) {
      expect(() => render(withRunner(runsOn))).toThrow(/is not a runner label set/)
    }
    expect(render(withRunner("[self-hosted, linux]"))).toContain("    runs-on: [self-hosted, linux]\n")
  })

  /**
   * The generated steps are the only thing the pipeline runs. `--help` made one
   * a usage message that exits 0 — a green pipeline that built and tested
   * nothing — and `*` reached the runner's shell to be expanded against the
   * checkout.
   */
  it("refuses a pattern that is not the CLI's label grammar", () => {
    for (
      const pattern of [
        "--help",
        "-h",
        "*",
        "//*",
        "//packages/*",
        "//packages/*:build",
        "...",
        "packages/core",
        "//",
        "//..",
        "//packages/../../etc",
        "//packages//core",
        "//packages/core:",
        "//packages/core:a:b",
        "//packages/core:--help",
        "//packages/core build",
        "//packages/core;rm -rf /",
        "//packages/core'",
        "//... && curl example.test"
      ]
    ) {
      const attrs = attrsOf({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "test",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ runtimes: [node] }),
          steps: [{ verb: Verb.Test, pattern }]
        }]
      })
      const message = (() => {
        try {
          render(attrs)
          return "rendered"
        } catch (cause) {
          return (cause as Error).message
        }
      })()
      expect({ pattern, refused: message.includes("is not a target pattern") }).toEqual({ pattern, refused: true })
    }
  })

  it("renders every supported pattern as one quoted shell word", () => {
    for (const pattern of ["//...", "//packages/...", "//packages/core", "//packages/core:build", "//:ci"]) {
      const rendered = render(attrsOf({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "test",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ runtimes: [node] }),
          steps: [{ verb: Verb.Test, pattern }]
        }]
      }))
      expect(rendered).toContain(`      - run: pnpm exec smithers-build test '${pattern}'\n`)
      expect(parseWorkflow(rendered).jobs[0]!.steps.map((step) => step.run))
        .toContain(`pnpm exec smithers-build test '${pattern}'`)
    }
  })

  it("refuses a parallelism no runner could honour", () => {
    for (const parallelism of [0, -1, 257, 1.5]) {
      expect(() =>
        GithubCiGen({
          ...goldenAttrs,
          gates: [],
          jobs: [{
            id: "test",
            runsOn: "ubuntu-latest",
            toolchain: CiToolchain.Needs({ runtimes: [node] }),
            steps: [{ verb: Verb.Test, pattern: "//...", parallelism }]
          }]
        } as never)
      ).toThrow()
    }
  })

  it("emits only verbs the CLI actually defines", async () => {
    const cli = await Fs.readFile(NodePath.resolve(import.meta.dirname, "../../build-cli/src/Cli.ts"), "utf8")
    const commands = new Set([...cli.matchAll(/\.command\("([\w-]+)"/g)].map((match) => match[1]!))
    expect(commands.size).toBeGreaterThan(0)
    expect(Verb.all.map(Verb.kind).filter((verb) => !commands.has(verb))).toEqual([])
    expect(commands.has("ci")).toBe(true)
    const emitted = new Set<string>()
    for (const verb of [...Verb.all, Verb.Ci]) {
      const rendered = render(attrsOf({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "test",
          runsOn: "ubuntu-latest",
          toolchain: CiToolchain.Needs({ runtimes: [node] }),
          steps: [{ verb, pattern: "//..." }]
        }]
      }))
      for (const [, emittedVerb] of rendered.matchAll(/pnpm exec smithers-build ([\w-]+) /g)) emitted.add(emittedVerb!)
    }
    expect([...emitted].filter((verb) => !commands.has(verb))).toEqual([])
  })

  it("derives the browser assertion and the artifact upload from declarations", () => {
    const rendered = render(attrsOf({
      ...goldenAttrs,
      gates: [],
      jobs: [{
        id: "e2e",
        runsOn: "ubuntu-latest",
        toolchain: CiToolchain.Needs({
          runtimes: [node],
          browser: CiToolchain.Browser({ executable: "/usr/bin/google-chrome", reason: "the runner image ships it" }),
          artifacts: CiToolchain.Artifacts({
            artifact: "e2e-artifacts",
            sources: [{ from: "/tmp/shot-*.png" }, { from: "apps/reports", as: "reports" }]
          })
        }),
        steps: [{ verb: Verb.Test, pattern: "//apps/ui" }]
      }]
    }))
    expect(rendered).toContain("          if [ ! -x '/usr/bin/google-chrome' ]; then\n")
    expect(rendered).toContain("          '/usr/bin/google-chrome' --version\n")
    expect(rendered).toContain("          mkdir -p \"$RUNNER_TEMP/e2e-artifacts\"\n")
    // Each copy is existence-guarded: a green run leaves no screenshots, and an
    // unexpanded glob handed to a bare `cp` fails the whole job (PR #1631).
    expect(rendered).toContain(
      "          for f in '/tmp/shot-'*'.png'; do if [ -e \"$f\" ]; then cp -R -- \"$f\" \"$RUNNER_TEMP/e2e-artifacts\"; fi; done\n"
    )
    // A fixed source needs the existence guard alone. Looping over one quoted
    // literal is SC2041 to the shellcheck actionlint runs, which failed the
    // required job on run 33442975322 at `.github/workflows/ci.yml:123:9`.
    expect(rendered).toContain(
      "          if [ -e 'apps/reports' ]; then cp -R -- 'apps/reports' \"$RUNNER_TEMP/e2e-artifacts/reports\"; fi\n"
    )
    expect(rendered).not.toContain("cp -R -- '/tmp/shot-'*'.png'")
    expect(rendered).not.toContain("2>/dev/null || true")
    expect(rendered).toContain("          if-no-files-found: ignore\n")
    // Issue #176: the generated workflow carries no step condition at all, so
    // nobody has to adjudicate in review which conditions are load-bearing.
    expect(rendered).not.toMatch(/^\s*if:/m)
  })

  it("refuses a declared path or diagnostic a shell would reinterpret", () => {
    for (const executable of ["/usr/bin/chrome; rm -rf /", "$(which chrome)", "/usr/bin/../../etc/passwd"]) {
      expect(() => CiToolchain.Browser({ executable, reason: "because" })).toThrow(/is not a usable/)
    }
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [],
        jobs: [{
          id: "e2e",
          runsOn: "ubuntu-latest",
          toolchain: {
            ...CiToolchain.Needs({ runtimes: [node] }),
            browser: { executable: "/usr/bin/chrome", reason: "it's `there`" }
          },
          steps: [{ verb: Verb.Test, pattern: "//..." }]
        }]
      }))
    ).toThrow(/not usable as a generated diagnostic/)
  })

  /**
   * The workflow-lint step runs actionlint, and actionlint runs shellcheck over
   * every generated script. A source with no glob rendered
   * `for f in 'apps/reports'; do ...`, one quoted literal as the whole list,
   * which shellcheck reports as SC2041 ("This is a literal string. To run as a
   * command, use $(..) instead of '..'"). That finding failed the required
   * `test` job on run 33442975322 at `.github/workflows/ci.yml:123:9` while the
   * pipeline it lints was otherwise fine.
   *
   * A loop is what a GLOB needs. A fixed path needs the existence guard alone,
   * and gets it.
   */
  it("collects a fixed artifact source without looping over one literal", () => {
    const steps = artifactSteps({
      artifact: "e2e-artifacts",
      sources: [{ from: "/tmp/shot-*.png" }, { from: "apps/reports", as: "reports" }]
    })
    const script = steps[0]!.run!
    expect(script).toContain(
      "if [ -e 'apps/reports' ]; then cp -R -- 'apps/reports' \"$RUNNER_TEMP/e2e-artifacts/reports\"; fi"
    )
    // The glob still needs the loop: `cp` on an unexpanded pattern exits 1.
    expect(script).toContain(
      "for f in '/tmp/shot-'*'.png'; do if [ -e \"$f\" ]; then cp -R -- \"$f\" \"$RUNNER_TEMP/e2e-artifacts\"; fi; done"
    )
    // No `for` loop anywhere whose whole list is a single quoted literal.
    expect(script.split("\n").filter((line) => /^\s*for \w+ in '[^'*]*';/.test(line))).toEqual([])
  })

  it("validates artifact values again at the rendering boundary", () => {
    expect(() => artifactSteps({ artifact: "artifacts; touch pwned", sources: [] })).toThrow(/artifact name/)
    expect(() => artifactSteps({ artifact: "artifacts", sources: [{ from: "$(touch pwned)" }] })).toThrow(
      /artifact source/
    )
  })

  it("maps a declared secret onto the repository secret of the same name", () => {
    const rendered = render(attrsOf({
      ...goldenAttrs,
      cacheUrlSecret: Secret("REMOTE_CACHE_URL"),
      cacheTokenSecret: Secret("PROJECT_CACHE_TOKEN")
    }))
    expect(rendered).toContain(
      "          REMOTE_CACHE_URL: \"${{ secrets.REMOTE_CACHE_URL }}\"\n" +
        "          PROJECT_CACHE_TOKEN: \"${{ secrets.PROJECT_CACHE_TOKEN }}\""
    )
  })
})

describe("GithubCiGen target wiring", () => {
  const checkingAttrs = {
    workflowName: "CI",
    pushBranches: ["main"],
    pullRequest: true,
    workflowDispatch: true,
    cancelInProgress: true,
    jobs: [],
    requiredJobs: [],
    gates: [],
    output: ".github/workflows/ci.yml",
    packageManager
  }

  it("defaults to the non-mutating check mode", () => {
    const metadata = Target.metadata(GithubCiGen(checkingAttrs) as never)
    expect((metadata.attrs as { readonly mode: string }).mode).toBe("check")
    // The workflow file is a declared input, so editing it re-keys the target.
    expect(metadata.inputs.map((input) => (input as { readonly path: string }).path))
      .toContain("//.github/workflows/ci.yml")
    expect(metadata.cacheable).toBe(true)
  })

  it("maps the lint verb of a writing target to the checking form", () => {
    const metadata = Target.metadata(GithubCiGen({ ...goldenAttrs }) as never)
    expect((metadata.attrs as { readonly mode: string }).mode).toBe("write")
    expect((metadata.forKind("lint").attrs as { readonly mode: string }).mode).toBe("check")
    // A writing target is not cacheable; its checking form is.
    expect(metadata.cacheable).toBe(false)
    expect(metadata.forKind("lint").cacheable).toBe(true)
  })
})

/**
 * One build matrix over the platforms, instead of one copy-pasted job per
 * platform.
 *
 * The generator emits no `if:` key, so a lane that is allowed to be red cannot
 * say so with a condition. It says so with data: each row carries its own
 * `advisory` bit in an `include:` row, and the job's `continue-on-error` reads
 * that bit out of the matrix context. A platform is promoted from advisory to
 * required by flipping one boolean in BUILD.ts, which is a diff a reviewer can
 * read, and the promotion is checked — a job listed in `requiredJobs` whose
 * every lane is advisory is refused rather than rendered.
 */
describe("a platform matrix", () => {
  const toolchain = CiToolchain.Needs({ runtimes: [node] })
  const step = { name: "Package test targets", verb: Verb.Test, pattern: "//packages/..." }
  const matrixJob = {
    id: "packages",
    name: "package suites (${{ matrix.os }})",
    matrix: [
      { os: "ubuntu-latest", advisory: false },
      { os: "macos-latest", advisory: true },
      { os: "windows-latest", advisory: true }
    ],
    timeoutMinutes: 60,
    toolchain,
    steps: [step]
  }
  const withMatrixJob = (job: unknown, requiredJobs: ReadonlyArray<string> = []): never =>
    attrsOf({ ...goldenAttrs, gates: [], requiredJobs, jobs: [job] })

  it("renders one job over every declared platform, with the advisory bit as data", () => {
    const rendered = render(withMatrixJob(matrixJob, ["packages"]))
    expect(rendered).toContain(
      `  packages:
    name: "package suites (\${{ matrix.os }})"
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        include:
          - os: ubuntu-latest
            advisory: false
          - os: macos-latest
            advisory: true
          - os: windows-latest
            advisory: true
    runs-on: \${{ matrix.os }}
    timeout-minutes: 60
    continue-on-error: \${{ matrix.advisory }}
    steps:
`
    )
    // Every row runs the same steps, rendered once.
    expect(rendered.split("smithers-build test '//packages/...'").length - 1).toBe(1)
    // The rule the whole module rests on survives the new key.
    expect(rendered).not.toContain("if:")
  })

  it("renders deterministically and reads back as one job", () => {
    const rendered = render(withMatrixJob(matrixJob))
    expect(render(withMatrixJob(matrixJob))).toBe(rendered)
    const workflow = parseWorkflow(rendered)
    expect(workflow.jobs.map((job) => job.id)).toEqual(["packages"])
    expect(workflow.jobs[0]!.runsOn).toBe("${{ matrix.os }}")
    expect(workflow.jobs[0]!.condition).toBeUndefined()
    expect(workflow.jobs[0]!.continueOnError).toBe("${{ matrix.advisory }}")
  })

  it("refuses a job that declares both a runner and a matrix, or neither", () => {
    expect(() => render(withMatrixJob({ ...matrixJob, runsOn: "ubuntu-latest" })))
      .toThrow(/declares both runs-on and a matrix/)
    const { matrix: _matrix, ...noRunner } = matrixJob
    expect(() => render(withMatrixJob(noRunner))).toThrow(/declares no runs-on and no matrix/)
  })

  it("refuses a matrix row that is not one runner label", () => {
    for (const os of ["[self-hosted, linux]", "${{ matrix.os }}", "ubuntu latest", "false", "on"]) {
      expect(() => render(withMatrixJob({ ...matrixJob, matrix: [{ os, advisory: false }] })))
        .toThrow(/is not a runner label; use one label per matrix row/)
    }
    // The schema refuses an empty label before `render` ever sees it.
    expect(() => withMatrixJob({ ...matrixJob, matrix: [{ os: "", advisory: false }] }))
      .toThrow(/length of at least 1/)
  })

  it("refuses an empty matrix and a repeated platform", () => {
    expect(() => render(withMatrixJob({ ...matrixJob, matrix: [] }))).toThrow(/declares an empty matrix/)
    expect(() =>
      render(withMatrixJob({
        ...matrixJob,
        matrix: [{ os: "ubuntu-latest", advisory: false }, { os: "ubuntu-latest", advisory: true }]
      }))
    ).toThrow(/repeats the matrix platform "ubuntu-latest"/)
  })

  /**
   * A job-level `continue-on-error: true` would make every row advisory while
   * the include rows still claim otherwise: two descriptions of one thing, free
   * to disagree.
   */
  it("refuses a job-level advisory bit beside a per-row one", () => {
    expect(() => render(withMatrixJob({ ...matrixJob, continueOnError: true })))
      .toThrow(/declares continue-on-error beside a matrix/)
  })

  /**
   * `requiredJobs` is the list of lanes the pipeline promises to run. A lane
   * that is advisory everywhere runs nothing the pipeline can fail on, so
   * naming it required is a claim the workflow does not keep.
   */
  it("refuses a required job whose every lane is advisory", () => {
    expect(() =>
      render(withMatrixJob(
        { ...matrixJob, matrix: matrixJob.matrix.map((row) => ({ ...row, advisory: true })) },
        ["packages"]
      ))
    ).toThrow(/required job "packages" is advisory on every platform/)
    expect(() =>
      render(attrsOf({
        ...goldenAttrs,
        gates: [],
        requiredJobs: ["rust"],
        jobs: goldenAttrs.jobs.map((job) => job.id !== "rust" ? job : { ...job, continueOnError: true })
      }))
    ).toThrow(/required job "rust" is advisory on every platform/)
  })

  it("still admits no free-form command through the matrix", () => {
    expect(Object.keys(Job.fields).sort())
      .toEqual(["continueOnError", "id", "matrix", "name", "runsOn", "steps", "timeoutMinutes", "toolchain"])
    expect(Object.keys(MatrixRow.fields).sort()).toEqual(["advisory", "os"])
  })
})
