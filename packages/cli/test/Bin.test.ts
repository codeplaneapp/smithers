/**
 * The `smithers` executable, driven as an operator drives it.
 *
 * Everything here is a real process: the help surface, the exit-code contract,
 * the `--json` stdout contract, and every removed verb and flag from
 * rc-contract section 4.2. Those refusals only mean anything at the process
 * boundary — the promise is "exit 1 with a migration message", not "the
 * handler returns a typed error" — so they are asserted there.
 */
import { spawn, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Version } from "../src/index.ts"
import * as Unsupported from "../src/Unsupported.ts"
import * as Verb from "../src/Verb.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const binDirectory = fileURLToPath(new URL("../bin", import.meta.url))
const shim = join(binDirectory, "smithers.mjs")
// Outside the repository on purpose. `Project.root` walks up for `.flows/`,
// and this checkout grows one the moment any command runs in it, so a working
// directory under `packages/` would resolve the repository as the project root
// and every case would read the repository's own run state instead of the
// empty one it staged.
const temporaryDirectoryPrefix = join(tmpdir(), "smithers-cli-bin-")

/**
 * Every case here starts at least one real `smithers`, and starting one means
 * parsing the whole module graph through Node's type stripping. That is
 * seconds on an idle machine and much longer under a loaded one, so these
 * describes carry their own budget rather than the package's 30 s default.
 * The budget stays finite: a genuine hang still fails the run.
 */
const processBudget = { timeout: 240_000 }

const run = (args: ReadonlyArray<string>, environment: Readonly<Record<string, string>> = {}) => {
  const cwd = mkdtempSync(temporaryDirectoryPrefix)
  try {
    return spawnSync(process.execPath, ["--no-warnings", executable, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, ...environment }
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe("smithers executable", processBudget, () => {
  it("reports the package version", () => {
    const result = run(["--version"])

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(Version.packageVersion)
  })

  it("exits with usage status for malformed JSON input", () => {
    const result = run(["plan", "system/test", "--data", "{"])

    expect(result.status).toBe(2)
  })

  it("exits with usage status for a flag no command declares", () => {
    const result = run(["ls", "--filter", "review"])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain("--filter")
  })
})

describe("the help surface", processBudget, () => {
  const help = run(["--help"])

  it("lists exactly the section 4.1 verbs", () => {
    expect(help.status).toBe(0)
    for (const verb of Verb.subcommands) expect(help.stdout).toContain(verb.name)
  })

  it("advertises no removed verb", () => {
    // Matched on the help layout's own leading indentation so a word that
    // merely appears inside a description is not read as a listed command.
    for (const verb of Unsupported.removedVerbs) {
      expect(help.stdout).not.toMatch(new RegExp(`^\\s+${verb.name}\\s{2,}`, "m"))
    }
  })

  it("advertises no alias, which is what keeps the list the contract's list", () => {
    for (const alias of ["resume", "inspect", "why", "events", "gateway"]) {
      expect(help.stdout).not.toMatch(new RegExp(`^\\s+${alias}\\s{2,}`, "m"))
    }
  })
})

describe("removed verbs and flags at the process boundary", processBudget, () => {
  // The complete sets are driven through the parser in `Unsupported.test.ts`;
  // one process per entry would be several minutes of spawns for the same
  // fact. These cases pin what only a real process can show: the status code
  // and the message on stderr.
  it("refuses a removed verb with exit 1 and a migration message", () => {
    const result = run(["rewind", "run-1"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smithers rewind was removed in 1.0.0-rc.0")
    expect(result.stderr).toContain(`${Unsupported.migrationUrl}#rewind`)
  })

  it("names the sub-verb when a removed group is called with one", () => {
    const result = run(["worktrees", "prune"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smithers worktrees prune was removed in 1.0.0-rc.0")
  })

  it("refuses a removed flag with exit 1 rather than the parser's exit 2", () => {
    // Exit 2 would mean the parser rejected an unknown flag, which carries no
    // migration message: declaring these hidden is what buys the sentence.
    const result = run(["steer", "run-1", "--message", "hello", "--takeover"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smithers steer --takeover was removed in 1.0.0-rc.0")
  })

  it("refuses the plural `workflows`, which is the spelling section 4.2 lists", () => {
    // The singular is a command group only so `workflow list` stays reachable.
    // `workflows` is the 0.x did-you-mean key, so it is what a migrating
    // script says, and leaving it unregistered answered with the parser's
    // usage error (exit 2) and no migration message at all.
    const result = run(["workflows"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smithers workflows was removed in 1.0.0-rc.0")
    expect(result.stderr).toContain(`${Unsupported.migrationUrl}#workflows`)
  })

  it("keeps `workflow list` alive as the `ls` alias while removing the rest", () => {
    const listed = run(["--json", "workflow", "list"])
    const removed = run(["workflow", "run"])

    expect(listed.status).toBe(0)
    expect(JSON.parse(listed.stdout)).toMatchObject({ _tag: "flows" })
    expect(removed.status).toBe(1)
    expect(removed.stderr).toContain("was removed in 1.0.0-rc.0")
  })
})

describe("the SQLite-only database contract", processBudget, () => {
  it("accepts `--backend sqlite` as a no-op and exits 0", () => {
    const result = run(["--backend", "sqlite", "--json", "ls"])

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "flows" })
  })

  it("refuses `--backend pglite` with unsupported_database", () => {
    const result = run(["--backend", "pglite", "ls"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("unsupported_database")
    expect(result.stderr).toContain("SQLite only")
  })

  it("refuses SMITHERS_BACKEND=postgres, which a script exports rather than passes", () => {
    const result = run(["ls"], { SMITHERS_BACKEND: "postgres" })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("unsupported_database")
  })
})

describe("the --json stdout contract", processBudget, () => {
  it("prints exactly one JSON document on stdout and nothing else", () => {
    const result = run(["--json", "ls"])

    expect(result.status).toBe(0)
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1)
    expect(() => JSON.parse(result.stdout)).not.toThrow()
  })

  it("prints nothing at all under --quiet", () => {
    const result = run(["--json", "--quiet", "ls"])

    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
  })
})

describe("the signal exit codes", processBudget, () => {
  const interrupted = async (signal: "SIGINT" | "SIGTERM") => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    try {
      const child = spawn(process.execPath, ["--no-warnings", executable, "logs", "--follow"], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"]
      })
      const exited = new Promise<{ readonly status: number | null; readonly signal: string | null }>((resolve) => {
        child.on("exit", (status, killedBy) => resolve({ status, signal: killedBy }))
      })
      // The signal has to land after the handler is installed and the engine
      // has opened its database. A fixed sleep is a race: on a loaded machine
      // the module graph alone can take seconds to parse, and the process then
      // dies from the default action instead of running its teardown. The
      // control database appearing is the readiness proof.
      const database = join(cwd, ".flows", "control.db")
      const deadline = Date.now() + 120_000
      while (!existsSync(database) && Date.now() < deadline) await new Promise((wake) => setTimeout(wake, 25))
      expect(existsSync(database)).toBe(true)
      child.kill(signal)
      return await exited
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  it("exits 130 on SIGINT", async () => {
    expect(await interrupted("SIGINT")).toEqual({ status: 130, signal: null })
  }, 240_000)

  it("exits 143 on SIGTERM", async () => {
    expect(await interrupted("SIGTERM")).toEqual({ status: 143, signal: null })
  }, 240_000)
})

describe("the smithers bin shim", processBudget, () => {
  it("is the only binary the package declares, and ships in the tarball", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      readonly bin?: Record<string, string>
      readonly files?: ReadonlyArray<string>
    }

    // The imported `flows` bin is gone and `@smthrs/cli` owns the one
    // user-facing name (rc-contract.md section 3.4).
    expect(manifest.bin).toEqual({ smithers: "./bin/smithers.mjs" })
    expect(manifest.files).toContain("bin/**/*.mjs")
  })

  // The packaged install path needs a built artifact, so it is a capability
  // gate: `dist/esm/bin.js` exists in every tarball and in a built checkout,
  // and the suite also runs before `pnpm run build` in a fresh clone.
  const built = existsSync(join(packageRoot, "dist", "esm", "bin.js"))

  it.skipIf(!built)("runs the built entry when dist is present", () => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    try {
      const result = spawnSync(process.execPath, [shim, "--version"], { cwd, encoding: "utf8", timeout: 180_000 })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(Version.packageVersion)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("runs the working-tree source when dist is absent", () => {
    // The development path `scripts/check-local-smithers.mjs` requires: a fresh
    // checkout has no `dist`, and `pnpm exec smithers` must still run the code
    // under edit rather than a published build. The shim is copied into a
    // package root that has `src` and no `dist`, which is exactly that shape.
    const root = mkdtempSync(temporaryDirectoryPrefix)
    try {
      // The whole directory, not just the entry: the shim imports its
      // sibling helpers, and copying one file made this case fail the moment a
      // second one appeared.
      cpSync(binDirectory, join(root, "bin"), { recursive: true })
      symlinkSync(join(packageRoot, "src"), join(root, "src"), "dir")
      expect(existsSync(join(root, "dist"))).toBe(false)

      const result = spawnSync(process.execPath, [join(root, "bin", "smithers.mjs"), "--version"], {
        cwd: root,
        encoding: "utf8",
        timeout: 180_000
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(Version.packageVersion)
      // Type stripping is experimental on Node 22; the shim silences that one
      // warning so a development invocation is not prefixed with a paragraph.
      expect(result.stderr).not.toContain("Type Stripping")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * rc-contract section 6 detection, at the process boundary.
 *
 * The rule is "0.x markers and no `.flows/` beside them", and the CLI creates
 * `<root>/.flows` as soon as it opens the control database. Sampling the
 * markers from a handler therefore looked at a directory the same invocation
 * had just written, and the notice never printed on the projects it exists
 * for. Only a real process can catch that, because in-process assertions on
 * `Project.legacyState` pass either way.
 */
describe("Smithers 0.x detection", processBudget, () => {
  const stage = (): string => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    mkdirSync(join(cwd, ".smithers", "workflows"), { recursive: true })
    writeFileSync(join(cwd, ".smithers", "workflows", "ship.tsx"), "export default null\n")
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "legacy" }))
    // The real 0.x table and column names (`packages/db/src/sql-message-storage.js`
    // in the 0.x tree), because the point of the check is that it reads a
    // database the old CLI wrote.
    const database = new DatabaseSync(join(cwd, "smithers.db"))
    database.exec(
      `CREATE TABLE _smithers_runs (
         run_id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, status TEXT NOT NULL
       )`
    )
    database.exec(
      "INSERT INTO _smithers_runs VALUES ('run-old-1','ship','running'),('run-old-2','ship','finished')"
    )
    database.close()
    return cwd
  }

  const inProject = (cwd: string, args: ReadonlyArray<string>) =>
    spawnSync(process.execPath, ["--no-warnings", executable, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 180_000
    })

  it("prints the section 6 notice on a first command in a 0.x project", () => {
    const cwd = stage()
    try {
      const result = inProject(cwd, ["ls", "--json"])

      // Informational: it names the state and does not change the exit code.
      expect(result.status).toBe(0)
      expect(result.stderr).toContain("Found Smithers 0.x state at")
      expect(result.stderr).toContain("does not load, resume, or migrate 0.x run databases")
      expect(result.stderr).toContain("https://smithers.sh/migration/1.0#run-data")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("refuses to migrate a project that still holds non-terminal 0.x runs", () => {
    const cwd = stage()
    try {
      const result = inProject(cwd, ["migrate"])

      // The section 6 guard, and it has to win over every later check: the
      // operator's next step is the 0.x CLI, not installing a flow.
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("Refusing to migrate")
      expect(result.stderr).toContain("run-old-1 running (ship)")
      expect(result.stderr).not.toContain("run-old-2")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("still refuses once the project has an rc.0 state directory", () => {
    const cwd = stage()
    try {
      // The realistic order: the operator runs something in the project
      // first, which writes `.flows/`, and only then reaches for `migrate`.
      // Section 6 gates the informational notice on `.flows/` being absent;
      // it does not gate the refusal, and gating it there would retire the
      // guard for every project that ever ran an rc.0 command.
      expect(inProject(cwd, ["ls", "--json"]).status).toBe(0)
      expect(existsSync(join(cwd, ".flows"))).toBe(true)

      const result = inProject(cwd, ["migrate"])

      expect(result.status).toBe(1)
      expect(result.stderr).toContain("Refusing to migrate")
      expect(result.stderr).toContain("run-old-1 running (ship)")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("keeps reporting the old database in doctor after the state directory exists", () => {
    const cwd = stage()
    try {
      expect(inProject(cwd, ["ls", "--json"]).status).toBe(0)

      const report = JSON.parse(inProject(cwd, ["doctor", "--json"]).stdout) as {
        readonly checks: ReadonlyArray<{ readonly name: string; readonly detail: string }>
      }
      const legacy = report.checks.filter((check) => check.name === "smithers 0.x")

      expect(legacy.some((check) => check.detail.includes("1 non-terminal runs"))).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("reports the 0.x paths and the runs the old database still holds", () => {
    const cwd = stage()
    try {
      const result = inProject(cwd, ["doctor", "--json"])
      const report = JSON.parse(result.stdout) as {
        readonly checks: ReadonlyArray<{ readonly name: string; readonly detail: string }>
      }
      const legacy = report.checks.filter((check) => check.name === "smithers 0.x")

      expect(legacy.map((check) => check.detail).join("\n")).toContain(".smithers")
      // `running` is non-terminal and `finished` is not, and the count is
      // what tells an operator whether the 0.x CLI still has work to finish.
      expect(legacy.some((check) => check.detail.includes("1 non-terminal runs"))).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
