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
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"
import * as CodexAuth from "../src/CodexAuth.ts"
import { cli } from "../src/Command.ts"
import * as Environment from "../src/Environment.ts"
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

const runIn = (
  cwd: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {}
) =>
  spawnSync(process.execPath, ["--no-warnings", executable, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    // `HOME` points at the same empty directory so a fallback that writes to
    // the home tree instead of the working directory is caught by the same
    // assertion.
    env: { ...process.env, HOME: cwd, ...environment }
  })

const inEmptyDirectory = <A>(use: (cwd: string) => A): A => {
  const cwd = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
  try {
    return use(cwd)
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

  /**
   * `--version` and `--help` are documents, not work. They resolved a project
   * root, scanned its `flows/` tree, and opened both SQLite databases before
   * `effect/unstable/cli` decided the invocation only wanted a document. In
   * the Phase 7 smoke that cost more than ten minutes: the invocation
   * directory held no project marker, the walk climbed to `$HOME`, and
   * discovery scanned the whole home tree.
   *
   * The staged tree below is that shape in miniature: an ancestor holding
   * `.flows/` (so the walk anchors there) and a `flows/` directory with
   * enough entries that a scan is unmistakably slower than the budget.
   */
  const stageHomeProject = (entries: number): string => {
    const home = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    mkdirSync(join(home, ".flows"), { recursive: true })
    for (let index = 0; index < entries; index++) {
      const directory = join(home, "flows", `pkg${index}`, "sub")
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "README.md"), "x")
    }
    mkdirSync(join(home, "deep", "nested"), { recursive: true })
    return home
  }

  it("answers --version without discovery or a database, from a directory with no project marker", () => {
    const home = stageHomeProject(24)
    try {
      const result = spawnSync(process.execPath, ["--no-warnings", executable, "--version"], {
        cwd: join(home, "deep", "nested"),
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: home }
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(Version.packageVersion)
      expect(existsSync(join(home, ".flows", "control.db"))).toBe(false)
      expect(existsSync(join(home, ".flows", "engine.db"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("answers --help without discovery or a database, from a directory with no project marker", () => {
    const home = stageHomeProject(24)
    try {
      const result = spawnSync(process.execPath, ["--no-warnings", executable, "--help"], {
        cwd: join(home, "deep", "nested"),
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: home }
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("plan")
      expect(existsSync(join(home, ".flows", "control.db"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("exits with usage status for malformed JSON input", () => {
    const result = run(["plan", "system/test", "--data", "{"])

    expect(result.status).toBe(2)
  })

  it("reports invalid pre-parse configuration as flag-specific usage errors", () => {
    inEmptyDirectory((cwd) => {
      const missing = join(cwd, "missing.json")
      const malformed = join(cwd, "malformed.json")
      writeFileSync(malformed, "{")

      const remoteResult = runIn(cwd, ["--remote", "nota", "ps"])
      const missingResult = runIn(cwd, ["--mcp-config", missing, "ps"])
      const malformedResult = runIn(cwd, ["--mcp-config", malformed, "ps"])

      expect(remoteResult.status).toBe(2)
      expect(remoteResult.stderr).toContain('--remote must be an http:// or https:// URL; got "nota"')
      expect(missingResult.status).toBe(2)
      expect(missingResult.stderr).toContain(`--mcp-config ${missing}: file not found`)
      expect(malformedResult.status).toBe(2)
      expect(malformedResult.stderr).toContain(`--mcp-config ${malformed} is not valid JSON:`)
      for (const output of [
        remoteResult.stderr,
        missingResult.stderr,
        malformedResult.stderr
      ]) {
        expect(output).not.toContain("TypeError")
        expect(output).not.toContain("ENOENT")
        expect(output).not.toContain("SyntaxError")
      }
    })
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

  it("answers `gateway status` and `gateway stop` with the section 4.2 message, not a usage error", () => {
    // Section 4.2 keeps bare `gateway` as the `serve` alias and removes the
    // two subcommands. Leaving them unregistered made the parser reject them
    // as stray positional arguments: exit 2, serve's help, and no migration
    // message — the same defect the plural `workflows` had.
    const status = run(["gateway", "status"])
    const stop = run(["gateway", "stop"])

    expect(status.status).toBe(1)
    expect(status.stderr).toContain("smithers gateway status was removed in 1.0.0-rc.0")
    expect(status.stderr).toContain(`${Unsupported.migrationUrl}#gateway`)
    expect(stop.status).toBe(1)
    expect(stop.stderr).toContain("smithers gateway stop was removed in 1.0.0-rc.0")
  })

  it("refuses `workflow run` under the packs reason and the singular spelling", () => {
    // Section 4.2 lists `workflow run|path|create|inspect|skills|doctor` under
    // "Packs and scaffolding". Reusing the `workflows` entry printed the
    // plural spelling and the "use `ls`" reason, which sends an operator
    // looking for a listing when what they lost was pack tooling.
    const result = run(["workflow", "path", "ship.tsx"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smithers workflow path was removed in 1.0.0-rc.0")
    expect(result.stderr).toContain("JSX pack tooling is gone")
    expect(result.stderr).toContain(`${Unsupported.migrationUrl}#workflow`)
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

describe("a removed verb refuses before the control plane boots", processBudget, () => {
  /**
   * A refusal is a sentence, not work.
   *
   * Every removed verb used to run under `NodeControl.layer`, so before the
   * one documented sentence reached stderr the process created
   * `<cwd>/.flows/`, opened `engine.db`, and opened `control.db`. Two costs
   * followed. An operator who typed a 0.x verb in any directory got a project
   * state directory there as the side effect of being told the verb is gone.
   * And `scripts/docs-removals.test.mjs` spawns the 75 removed forms eight at
   * a time in one working directory, so eight processes contended on the same
   * two SQLite files and answered with `disk I/O error` or with nothing before
   * the harness's fifteen-second bound.
   *
   * The proof is the file system: run the refusal in an empty directory and
   * assert that it is still empty afterwards.
   */
  it("prints its sentence and leaves the working directory empty", () => {
    const ui = Unsupported.removedVerbs.find((verb) => verb.name === "ui")!

    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["ui"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr.trim()).toBe(Unsupported.message("ui", ui.reason, "ui"))
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("leaves the working directory empty for a removed form of a surviving parent", () => {
    const gateway = Unsupported.removedVerbs.find((verb) => verb.name === "gateway")!

    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["gateway", "status"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr.trim()).toBe(Unsupported.message("gateway status", gateway.reason, "gateway"))
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("still boots the control plane for a surviving verb", () => {
    // The guard is scoped to the removal table. `ls` is a real verb, so it
    // still resolves a project and opens its databases, and a guard that
    // swallowed it would show up here rather than as a silent listing of
    // nothing.
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["--json", "ls"])

      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "flows" })
      expect(readdirSync(join(cwd, ".flows")).sort()).toContain("control.db")
    })
  })
})

describe("an invocation that never runs a command answers before the control plane boots", processBudget, () => {
  /**
   * A removed verb refused file-free, and every other non-running invocation
   * did not.
   *
   * `smithers lss` is a typo. The parser answers it with exit 2 and a
   * did-you-mean list, and no handler ever runs, yet the process still built
   * `NodeControl.layer` on its way to the parse: it created `<cwd>/.flows/`
   * and opened `engine.db` and `control.db` before printing usage. The same
   * held for a one-token verb (`smithers "gateway status"`, the shape a shell
   * script produces when it quotes a whole command) and for an unrecognized
   * flag on a real verb (`smithers ps --nope`).
   *
   * The rule is the same one the removed verbs got: an invocation that will
   * not run a real command touches no file. `bin.ts` now attaches the durable
   * layer to the command's handler rather than to the program, so the command
   * tree itself decides, and the layer is built only once a handler is about
   * to run.
   */
  it("answers an unknown subcommand with usage and leaves the working directory empty", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["lss"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("Unknown subcommand \"lss\" for \"smithers\"")
      expect(result.stdout).toContain("USAGE")
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("leaves the working directory empty for a one-token command line", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["gateway status"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("Unknown subcommand \"gateway status\" for \"smithers\"")
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("leaves the working directory empty for an unrecognized flag on a real verb", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["ps", "--nope"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("Unrecognized flag: --nope in command smithers ps")
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("leaves the working directory empty for a missing required argument", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["output"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("still builds the control plane for a real command", () => {
    // The other half of the contract. Moving the layer onto the handler must
    // not leave a shipped verb running without the services it declares, so a
    // verb that reads the durable stores is asserted to still open them.
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["--json", "ps"])

      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "runs" })
      expect(readdirSync(join(cwd, ".flows")).sort()).toContain("control.db")
    })
  })

  it("classifies every shipped verb as a real command, not an unknown subcommand", () => {
    // The resolver is the command tree, so every name the tree declares has to
    // resolve through it. A verb that stopped resolving would reach an
    // operator as a did-you-mean list for a verb that exists. The removed
    // verbs are swept by `scripts/docs-removals.test.mjs`, which spawns all 75
    // of them; this covers the surviving half.
    const declared = cli.subcommands.flatMap((group) => group.commands.map((command) => command.name))
    const shipped = Verb.subcommands.map((verb) => verb.name)

    expect(shipped.length).toBeGreaterThan(0)
    for (const name of shipped) {
      expect(declared, name).toContain(name)
      const result = inEmptyDirectory((cwd) => ({ ...runIn(cwd, [name, "--help"]), files: readdirSync(cwd) }))

      expect(result.stderr, name).not.toContain("Unknown subcommand")
      expect(result.status, name).toBe(0)
      expect(result.files, name).toEqual([])
    }
  })
})

describe("reserved system flow ids", processBudget, () => {
  // `SystemFlows.catalog` reserves 22 `system/*` ids so the control plane can
  // project a verb onto a flow row. None of them has a body in rc.0, so a
  // launch parks at `accepted` and never moves: the "partial appearance"
  // rc-contract section 4 forbids. They are not flows an operator may name.
  it("refuses to plan a reserved system flow", () => {
    const result = run(["plan", "system/replay", "--json"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smithers plan system/replay")
    expect(result.stderr).toContain("reserved system flow")
    expect(result.stdout).not.toContain("planId")
  })

  it("refuses to launch a reserved system flow instead of parking a run forever", () => {
    const result = run(["up", "system/release", "--json"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smithers up system/release")
    expect(result.stdout).not.toContain("Accepted")
  })

  it("lists no reserved system flow", () => {
    const result = run(["ls", "--json"])
    const listed = JSON.parse(result.stdout) as {
      readonly items: ReadonlyArray<{ readonly flowId: string }>
    }

    expect(result.status).toBe(0)
    expect(listed.items.filter((item) => item.flowId.startsWith("system/"))).toEqual([])
  })
})

describe("the SQLite-only database contract", processBudget, () => {
  it("accepts `--backend sqlite` as a no-op and exits 0", () => {
    const result = run(["--backend", "sqlite", "--json", "ls"])

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "flows" })
  })

  it("refuses `--backend pglite` with rc-contract section 2's sentence", () => {
    const result = run(["--backend", "pglite", "ls"])

    expect(result.status).toBe(1)
    // The whole sentence, not a substring: section 2 fixes it, and a
    // paraphrase that still contains "unsupported_database" is a contract
    // change an operator's script would not see coming.
    expect(result.stderr.trim()).toBe(Environment.unsupportedBackendMessage)
  })

  it("refuses SMITHERS_BACKEND=postgres, which a script exports rather than passes", () => {
    const result = run(["ls"], { SMITHERS_BACKEND: "postgres" })

    expect(result.status).toBe(1)
    expect(result.stderr.trim()).toBe(Environment.unsupportedBackendMessage)
  })

  it("says once that a PostgreSQL environment is ignored, and still succeeds", () => {
    const result = run(["--json", "ls"], {
      SMITHERS_POSTGRES_URL: "postgres://localhost/smithers",
      SMITHERS_TEST_PG_URL: "postgres://localhost/test"
    })

    // A notice, not a refusal: section 2 says these names are ignored, and an
    // ignored name must not change what the command does or what it returns.
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "flows" })
    expect(result.stderr.split("\n").filter((line) => line.startsWith("ignored: "))).toEqual([
      "ignored: SMITHERS_POSTGRES_URL has no effect in 1.0.0-rc.0 (SQLite only)",
      "ignored: SMITHERS_TEST_PG_URL has no effect in 1.0.0-rc.0 (SQLite only)"
    ])
  })

  it("refuses a 0.x database file by its contract code, on stderr", () => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    try {
      mkdirSync(join(cwd, ".flows"))
      // One table and no `flows_migrations`: exactly the shape the guard
      // refuses, and exactly the shape a 0.x `smithers.db` has.
      const zeroX = new DatabaseSync(join(cwd, ".flows", "control.db"))
      zeroX.exec("CREATE TABLE _smithers_runs (id TEXT PRIMARY KEY)")
      zeroX.close()

      const result = spawnSync(process.execPath, ["--no-warnings", executable, "ps"], {
        cwd,
        encoding: "utf8",
        timeout: 180_000,
        env: { ...process.env }
      })

      expect(result.status).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("unsupported_database_file: ")
      expect(result.stderr).toContain("is not a Smithers 1.0 database")
      // The tagged-error name is how the value travelled, not what the
      // contract promises an operator or what a script greps for.
      expect(result.stderr).not.toContain("@smthrs/database/UnsupportedDatabase")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe("the served gateway", processBudget, () => {
  /** A loopback port nothing else in this suite is using. */
  const port = 34_000 + Math.floor(Math.random() * 8000)

  it("answers every mount its banner advertises", async () => {
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    const child = spawn(process.execPath, ["--no-warnings", executable, "serve", "--port", String(port)], {
      cwd,
      env: { ...process.env }
    })
    let banner = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      banner += chunk
    })
    try {
      const base = `http://127.0.0.1:${port}`
      const deadline = Date.now() + 120_000
      let health: Response | undefined
      for (;;) {
        try {
          health = await fetch(`${base}/health`)
          break
        } catch (cause) {
          if (Date.now() > deadline) throw cause
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }

      // `GET /health` is the probe a supervisor uses to decide whether the
      // gateway it found belongs to this workspace, so it answers unauthenticated
      // and carries identity only.
      expect(health!.status).toBe(200)
      const identity = await health!.json() as Record<string, unknown>
      expect(typeof identity.workspaceHash).toBe("string")
      expect(identity.version).toBe(Version.packageVersion)

      // The three RPC mounts. A 404 here is the defect this case exists for:
      // the banner advertised routes only the control server carried.
      for (const path of ["/rpc", "/projections", "/sync"]) {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/ndjson" },
          body: ""
        })
        expect({ path, status: response.status }).not.toEqual({ path, status: 404 })
      }

      // Every line the banner advertises is a route that answered.
      expect(banner).toContain(`${base}/health`)
      expect(banner).toContain(`${base}/sync`)
      expect(banner).toContain("/projections/ws")
    } finally {
      child.kill("SIGTERM")
      await new Promise((resolve) => child.once("exit", resolve))
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 240_000)
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
    // `smithers docs` prints the bundles the docs lane generates into
    // `<package>/docs`. Left out of `files` they ship nowhere, and the verb
    // reports them missing on every published install.
    expect(manifest.files).toContain("docs/**")
  })

  it("runs the built entry when dist is present, and leaves src alone", () => {
    // The packaged install: a tarball ships `dist/esm/bin.js` beside `src`,
    // and the shim must run the build. Staging the build here rather than
    // gating on `existsSync(dist)` is the point — `dist` is gitignored, so the
    // gated form skipped in every fresh clone and in this worktree, which is
    // no pin at all. The marker proves which entry ran, where asserting
    // `--version` could not: both entries print the same version.
    const root = mkdtempSync(temporaryDirectoryPrefix)
    try {
      cpSync(binDirectory, join(root, "bin"), { recursive: true })
      symlinkSync(join(packageRoot, "src"), join(root, "src"), "dir")
      mkdirSync(join(root, "dist", "esm"), { recursive: true })
      writeFileSync(join(root, "dist", "esm", "bin.js"), "process.stdout.write(\"built entry ran\\n\")\n")

      const result = spawnSync(process.execPath, [join(root, "bin", "smithers.mjs"), "--version"], {
        cwd: root,
        encoding: "utf8",
        timeout: 180_000
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("built entry ran")
      // `src/bin.ts` is right there and must not have run: an installed CLI
      // that type-stripped its own sources would be running unbuilt code.
      expect(result.stdout).not.toContain(Version.packageVersion)
    } finally {
      rmSync(root, { recursive: true, force: true })
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
 * Stages a Smithers 0.x project whose runs are all terminal, so the section 6
 * refusal has nothing to hold and the verb gets as far as the migration tool.
 */
const stageLegacyProject = (directory: string): string => {
  mkdirSync(join(directory, ".smithers", "workflows"), { recursive: true })
  writeFileSync(join(directory, ".smithers", "workflows", "ship.tsx"), "export default null\n")
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "legacy" }))
  const database = new DatabaseSync(join(directory, "smithers.db"))
  // The 0.x run table with the columns the migration tool's run-state scan
  // reads. A three-column stand-in made every scan report the database as one
  // it "could not open read only", which is the message for a lock and reads
  // as a defect in the project rather than in the fixture.
  database.exec(
    `CREATE TABLE _smithers_runs (
       run_id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, workflow_path TEXT, status TEXT NOT NULL,
       heartbeat_at_ms INTEGER, runtime_owner_id TEXT, parent_run_id TEXT,
       pause_requested_at_ms INTEGER, cancel_requested_at_ms INTEGER
     )`
  )
  database.exec(
    "INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status) " +
      "VALUES ('run-old-1','ship','.smithers/workflows/ship.tsx','finished')"
  )
  database.close()
  return directory
}

/** One `smithers` process, run from inside a staged project. */
const inProject = (cwd: string, args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, ["--no-warnings", executable, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000
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

  it("prints the notice whichever command runs first, not only `ls` and `up`", () => {
    // Section 6 says "when a command runs in a directory", and an operator
    // arriving at a 0.x project types `ps` or `status` at least as often as
    // `ls`. Wiring the notice into two handlers meant the notice depended on
    // which verb happened to be typed first, and the second command never
    // printed it because the first had written `.flows/`.
    for (const argv of [["ps", "--json"], ["status"], ["doctor", "--json"]]) {
      const cwd = stage()
      try {
        const result = inProject(cwd, argv)

        expect(result.stderr).toContain("Found Smithers 0.x state at")
        expect(result.stderr).toContain("https://smithers.sh/migration/1.0#run-data")
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    }
  })

  it("prints the notice once per invocation", () => {
    const cwd = stage()
    try {
      const result = inProject(cwd, ["ls", "--json"])
      const notices = result.stderr.split("Found Smithers 0.x state at").length - 1

      expect(notices).toBe(1)
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

  it("reaches the migration tool shipped in @smthrs/migrate, not a project-local flow file", () => {
    // A 0.x project has no `flows/` directory by definition, so demanding one
    // made the verb unreachable for every project it exists for. The flow
    // ships inside `@smthrs/migrate` (rc-contract section 4.1, PLAN phase 6);
    // the verb runs that, and what it answers is the migration tool's own
    // report or the migration tool's own refusal.
    const cwd = mkdtempSync(temporaryDirectoryPrefix)
    try {
      mkdirSync(join(cwd, ".smithers", "workflows"), { recursive: true })
      writeFileSync(join(cwd, ".smithers", "workflows", "ship.tsx"), "export default null\n")
      writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "legacy" }))
      const database = new DatabaseSync(join(cwd, "smithers.db"))
      database.exec("CREATE TABLE _smithers_runs (run_id TEXT PRIMARY KEY, workflow_name TEXT, status TEXT)")
      // Terminal only: the section 6 refusal has nothing to hold, so the verb
      // gets as far as the tool.
      database.exec("INSERT INTO _smithers_runs VALUES ('run-old-1','ship','finished')")
      database.close()

      const result = inProject(cwd, ["migrate"])
      const output = `${result.stdout}${result.stderr}`

      expect(output).not.toContain("is not installed in this project")
      expect(output).not.toContain("Add it under flows/")
      // The migration tool's own rendering: `smithers migrate <mode>: <root>`,
      // or its own refusal, `smithers migrate: <reason>`.
      expect(output).toMatch(/smithers migrate (plan|scan|apply):|smithers migrate: /)
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

/**
 * rc-contract section 4.1 `migrate`, and ruling V-4's shape for it.
 *
 * The verb runs the flow that ships inside `@smthrs/migrate`, which is the
 * same entry `smithers-migrate` runs. A verb that reached that entry with
 * `apply: false` hardcoded could plan and nothing else, so the transformation
 * the contract row promises was unreachable however the operator typed it.
 * Only a real process can prove the flag set, because the parser is what
 * rejects an undeclared flag.
 */
describe("the migrate verb's option surface", processBudget, () => {
  /** A 0.x project whose runs are all terminal, so section 6 has nothing to hold. */
  const stageTerminal = (): string => stageLegacyProject(mkdtempSync(temporaryDirectoryPrefix))

  it("declares the migration tool's own flags", () => {
    const help = run(["migrate", "--help"])
    const text = `${help.stdout}${help.stderr}`

    // The set `packages/migrate/src/flow/bin.ts` declares, minus `--json`,
    // which is a shared global here.
    for (
      const flag of [
        "--scan",
        "--apply",
        "--seat",
        "--allow-unsafe",
        "--acknowledge-run-state",
        "--allow-no-vcs",
        "--keep-old-sources",
        "--unit",
        "--max-repair-rounds",
        "--report-dir",
        "--flows-dir",
        "--verify-install",
        "--verify-format",
        "--verify-typecheck",
        "--verify-test"
      ]
    ) {
      expect(text, flag).toContain(flag)
    }
  })

  it("runs the tool in scan mode when --scan is given", () => {
    const cwd = stageTerminal()
    try {
      const result = inProject(cwd, ["migrate", "--scan"])
      const output = `${result.stdout}${result.stderr}`

      expect(output).not.toContain("Unrecognized flag")
      // The tool's own heading names the mode it ran in, so this is the mode
      // reaching the flow rather than the flag being parsed and dropped.
      expect(output).toContain("smithers migrate scan:")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("reaches apply mode with --apply, where plan mode never writes", () => {
    const cwd = stageTerminal()
    try {
      const result = inProject(cwd, ["migrate", "--apply"])
      const output = `${result.stdout}${result.stderr}`

      expect(output).not.toContain("Unrecognized flag")
      // Plan mode renders its own heading and exits 0; apply mode is the only
      // one the run-state gate parks. Reaching that park is the proof the mode
      // arrived, and 3 is the status `smithers-migrate` gives a park.
      expect(output).not.toContain("smithers migrate plan:")
      expect(result.status).toBe(3)
      expect(output).toContain("--acknowledge-run-state")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * Which project `smithers migrate` converts.
 *
 * The verb's default target used to be the rc.0 project root, whose walk
 * anchors on `.flows/`. A 0.x project has none — that is what makes it a 0.x
 * project — so a project without a `.git`/`.jj` marker of its own resolved to
 * whatever rc.0 project sat above it, and `--apply` rewrote the ancestor's
 * tree. Only a real process shows it: the resolution happens while the layers
 * are built, before any handler runs.
 */
describe("the migrate verb's target", processBudget, () => {
  /** An rc.0 project with a 0.x project inside it and no VCS marker between them. */
  const stageNested = (): { readonly ancestor: string; readonly project: string } => {
    const ancestor = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    // The `.flows/` the root walk anchors on, and nothing else.
    mkdirSync(join(ancestor, ".flows"), { recursive: true })
    return { ancestor, project: stageLegacyProject(join(ancestor, "legacy-project")) }
  }

  it("converts the project the operator is standing in, not an rc.0 ancestor", () => {
    const { ancestor, project } = stageNested()
    try {
      const result = inProject(project, ["migrate", "--scan", "--json"])
      const report = JSON.parse(result.stdout) as {
        readonly root: string
        readonly units: ReadonlyArray<{ readonly id: string }>
      }

      expect(report.root).toBe(project)
      // The fixture's own units, and only those: its `package.json`, the one
      // workflow under `.smithers/workflows`, and the project itself. The scan
      // walks down, so these three appear from the ancestor too — `root` is
      // what separates the two answers, and `root` is what `--apply` writes
      // against.
      expect(report.units.map((unit) => unit.id)).toEqual(["dependencies", "workflow:ship", "project"])
    } finally {
      rmSync(ancestor, { recursive: true, force: true })
    }
  })

  it("names the tree it would rewrite when apply stops at the version-control gate", () => {
    const { ancestor, project } = stageNested()
    try {
      // The gate refuses before anything is written, and the refusal quotes the
      // directory the migration would have rewritten, so it reports the target
      // without producing one.
      const result = inProject(project, ["migrate", "--apply", "--acknowledge-run-state"])

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`"${project}" is under no version control`)
      expect(result.stderr).not.toContain(`"${ancestor}" is under no version control`)
      // And it wrote nothing anywhere.
      expect(existsSync(join(ancestor, ".smithers-migrate"))).toBe(false)
      expect(existsSync(join(project, ".smithers-migrate"))).toBe(false)
    } finally {
      rmSync(ancestor, { recursive: true, force: true })
    }
  })
})

/**
 * rc-contract section 4.1 `skills add`, under ruling F2.
 *
 * "Writes the curated skill only" is a promise about a file on disk, so it is
 * asserted against the file a real process wrote into a real home directory.
 * The failure it replaces was quiet: the verb rendered a stub from the verb
 * table and reported success, so an agent read a document that carried none of
 * the routing rules the curated skill teaches.
 *
 * Both cases run against an installation staged in a temp directory rather
 * than against this checkout. The two places the verb looks belong to other
 * lanes — `packages/cli/docs/SKILL.md` is the docs lane's generated copy and
 * `skills/smithers/SKILL.md` is the pack lane's source — so a case that
 * asserted this tree's state went red the day either lane landed, and a case
 * that wrote `packages/cli/docs/SKILL.md` overwrote and then deleted the real
 * generated file on every run.
 */
describe("smithers skills add", processBudget, () => {
  /**
   * A published installation: a package root holding `bin`, `src`, the
   * manifest, and whatever `docs` the case is about.
   *
   * `src` is copied rather than symlinked. Node resolves `import.meta.url`
   * through the real path, so a symlinked `src` would put `Docs.directory()`
   * back inside the checkout and the case would be about this worktree again.
   * `package.json` comes along because `Version.ts` self-references
   * `@smthrs/cli/package.json`, and `node_modules` is linked so the dependency
   * graph resolves.
   */
  const inInstallation = <A>(
    curated: string | undefined,
    body: (installation: { readonly root: string; readonly home: string }) => A
  ): A => {
    const root = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    const home = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    try {
      cpSync(binDirectory, join(root, "bin"), { recursive: true })
      cpSync(join(packageRoot, "src"), join(root, "src"), { recursive: true })
      cpSync(join(packageRoot, "package.json"), join(root, "package.json"))
      symlinkSync(join(packageRoot, "node_modules"), join(root, "node_modules"), "dir")
      if (curated !== undefined) {
        mkdirSync(join(root, "docs"), { recursive: true })
        writeFileSync(join(root, "docs", "SKILL.md"), curated, "utf8")
      }
      return body({ home, root })
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  }

  const skillsAdd = (root: string, home: string) =>
    spawnSync(process.execPath, [join(root, "bin", "smithers.mjs"), "skills", "add", "--agent", "claude"], {
      cwd: home,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, HOME: home }
    })

  const installedSkill = (home: string) => join(home, ".claude", "skills", "smithers", "SKILL.md")

  it("installs the curated file byte for byte, not a rendering of the verb table", () => {
    const curated = [
      "---",
      "name: smithers",
      "---",
      "",
      "# Smithers",
      "",
      "The curated skill, which a verb table cannot produce.",
      ""
    ].join("\n")

    inInstallation(curated, ({ home, root }) => {
      const result = skillsAdd(root, home)

      expect(result.status).toBe(0)
      expect(existsSync(installedSkill(home))).toBe(true)
      expect(readFileSync(installedSkill(home), "utf8")).toBe(readFileSync(join(root, "docs", "SKILL.md"), "utf8"))
      expect(readFileSync(installedSkill(home), "utf8")).not.toContain("## Commands")
    })
  })

  it("refuses when the installation ships no curated skill, naming both places it looked", () => {
    inInstallation(undefined, ({ home, root }) => {
      const result = skillsAdd(root, home)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain("No curated smithers skill in this installation")
      // The packaged copy and the checkout source, both named from the
      // installation under test.
      for (const path of Agents.skillSources(join(root, "docs"))) expect(result.stderr).toContain(path)
      // Nothing else is written in its place.
      expect(existsSync(installedSkill(home))).toBe(false)
    })
  })
})

/**
 * What an attached launch reports to the shell that started it.
 *
 * rc-contract section 4's `up` row and section 10 both promise "exit code
 * follows the terminal status", and that promise only exists at the process
 * boundary: a script, a `pipeline-*.yml` step, or a sandbox `run-workflow.sh`
 * reads `$?`, not a receipt. The Phase 7 Plue cutover measured the opposite —
 * `smithers up ci-fast --json` returned 0 in three seconds while `smithers ps`
 * reported `failed` (plue-cutover finding S1).
 *
 * The run below fails for real, with no provider and no network. The flow
 * declares an `openai` seat, `SMITHERS_OPENAI_AUTH=chatgpt` routes that seat
 * to the codex CLI's credential store, and the store this project points at
 * holds a file with no token set. The seat resolves — the file exists, so the
 * launch is accepted and the driver starts — and the turn then fails locally
 * reading it. That is a real `control.run.failed` settlement, written by the
 * real agent session into the project's own `.flows/control.db`.
 */
/** A project whose one flow's seat resolves and whose turns cannot. */
const stageUnservableSeat = (): string => {
  const cwd = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
  mkdirSync(join(cwd, "flows", "failing"), { recursive: true })
  writeFileSync(
    join(cwd, "flows", "failing", "flow.mdx"),
    [
      "---",
      "name: failing",
      "description: A flow whose seat resolves and whose first turn cannot.",
      "model: openai:gpt-5-mini",
      "---",
      "",
      "# failing",
      "",
      "Report the repository state.",
      ""
    ].join("\n")
  )
  mkdirSync(join(cwd, "codex"), { recursive: true })
  // A store the resolver accepts and the turn cannot use: `CodexAuth.locate`
  // only asks whether the file is there.
  writeFileSync(join(cwd, "codex", "auth.json"), "{}")
  return cwd
}

const launch = (cwd: string, args: ReadonlyArray<string>) =>
  spawnSync(process.execPath, ["--no-warnings", executable, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    env: {
      ...process.env,
      SMITHERS_OPENAI_AUTH: "chatgpt",
      CODEX_HOME: join(cwd, "codex")
    }
  })

describe("an attached launch's exit status", processBudget, () => {
  it("exits 1 for a run that settled failed, and still prints the receipt", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json"])

      expect(launched.error).toBeUndefined()
      expect(launched.status).toBe(1)
      // The `--json` contract does not move: stdout is one document, the
      // launch receipt, and `runId` is the only place a caller learns the run.
      // The run's own lifecycle warnings are diagnostics and belong on stderr;
      // written to stdout they land inside the document a pipeline parses.
      expect(launched.stdout.trimEnd().split("\n")).toHaveLength(1)
      const receipt = JSON.parse(launched.stdout) as { readonly runId?: unknown }
      expect(receipt.runId).toMatch(/^run-/)
      expect(launched.stderr).toContain("An agent run failed")

      // And the status the exit code claims is the status the control plane
      // recorded, read back by a second process.
      const listed = launch(cwd, ["ps", "--json"])
      expect(listed.status).toBe(0)
      const runs = (JSON.parse(listed.stdout) as {
        readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string }>
      }).items
      expect(runs.find((entry) => entry.runId === receipt.runId)?.status).toBe("failed")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /**
   * One refusal is one operator line.
   *
   * The billing refusal in the Phase 7 smoke printed two WARN stacks for one
   * failure (observation N1): the run's own `An agent run failed`, and
   * `engine-store: the settlement of agent/run could not be encoded through
   * its own codec`. The second is not a second failure. It fires because the
   * `agent/run` flow declares `error: Schema.Unknown` and the body fails with
   * an `Error` instance, which is not a JSON value, so EVERY agent failure
   * degraded its durable settlement into a projection and told the operator
   * about it in a second stack trace. The cause is the same one the first line
   * already named.
   */
  it("prints one operator-facing warning for one refusal", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json"])

      expect(launched.error).toBeUndefined()
      expect(launched.status).toBe(1)
      const warnings = launched.stderr.split("\n").filter((line) => line.includes("WARN"))

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("An agent run failed")
      expect(launched.stderr).not.toContain("could not be encoded through its own codec")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /** Every run decision the engine journal holds for a run, in order. */
  const engineDecisions = (cwd: string, runId: string): ReadonlyArray<string> => {
    const handle = new DatabaseSync(join(cwd, ".flows", "engine.db"), { readOnly: true })
    try {
      return (handle.prepare(
        "SELECT payload_json FROM flows_journal_events WHERE run_id = ? " +
          "AND event_type = 'flows.engine.run-decision' ORDER BY seq"
      ).all(runId) as unknown as ReadonlyArray<{ readonly payload_json: string }>)
        .map((row) => String((JSON.parse(row.payload_json) as { decision?: unknown }).decision))
    } finally {
      handle.close()
    }
  }

  /** One run's engine row, as the next process finds it. */
  const engineRun = (cwd: string, runId: string): { status: string; finished_at_ms: number | null } | undefined => {
    const handle = new DatabaseSync(join(cwd, ".flows", "engine.db"), { readOnly: true })
    try {
      return handle.prepare(
        "SELECT status, finished_at_ms FROM flows_runs WHERE run_id = ?"
      ).get(runId) as unknown as { status: string; finished_at_ms: number | null } | undefined
    } finally {
      handle.close()
    }
  }

  /** How many turns the control journal recorded for a run. */
  const turnsOpened = (cwd: string, runId: string): number => {
    const handle = new DatabaseSync(join(cwd, ".flows", "control.db"), { readOnly: true })
    try {
      return (handle.prepare(
        "SELECT COUNT(*) AS turns FROM flows_journal_events WHERE run_id = ? " +
          "AND event_type = 'control.agent.turn-opened'"
      ).get(runId) as unknown as { readonly turns: number }).turns
    } finally {
      handle.close()
    }
  }

  /**
   * What the launching process leaves in `engine.db` when it exits.
   *
   * The control settlement and the engine's terminal write are two writes, and
   * this process returns on the first. In the Phase 7 smoke it then closed its
   * scope and interrupted its own executor 10 to 14 ms before the second one
   * landed, leaving the row `suspended`/`released`; every later process that
   * composed an executor claimed that row and re-drove the run. The pin is at
   * the process boundary because the promise is about what is on disk after
   * the process is gone.
   */
  it("leaves a terminal engine row behind, with no interrupt-released decision", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json"])
      expect(launched.status).toBe(1)
      const runId = (JSON.parse(launched.stdout) as { readonly runId: string }).runId

      const row = engineRun(cwd, runId)
      expect(row?.status).toBe("failed")
      expect(row?.finished_at_ms).not.toBeNull()
      expect(engineDecisions(cwd, runId)).not.toContain("interrupt-released")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("is not claimed, re-driven, or re-opened by the next process over the same project", () => {
    const cwd = stageUnservableSeat()
    try {
      const first = launch(cwd, ["up", "failing", "--json"])
      expect(first.status).toBe(1)
      const runId = (JSON.parse(first.stdout) as { readonly runId: string }).runId
      const decisions = engineDecisions(cwd, runId)
      const turns = turnsOpened(cwd, runId)

      // A second `smithers` over the same `.flows`, which composes its own
      // executor exactly as every local verb does.
      const second = launch(cwd, ["up", "failing", "--json"])
      expect(second.status).toBe(1)
      expect((JSON.parse(second.stdout) as { readonly runId: string }).runId).not.toBe(runId)

      expect(engineDecisions(cwd, runId)).toEqual(decisions)
      expect(decisions).not.toContain("stolen-and-activated")
      expect(turnsOpened(cwd, runId)).toBe(turns)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /**
   * `run --resume` against a run that has already settled.
   *
   * `Control.resume` answers `{"_tag":"Terminal","runId":...,"status":...}`
   * and there is no settlement event left to wait for, so the verb reported
   * nothing and exited 0 for a run its own document called `failed`.
   */
  it("exits 1 from `run --resume` against a run that already settled failed", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json"])
      expect(launched.status).toBe(1)
      const runId = (JSON.parse(launched.stdout) as { readonly runId: string }).runId

      const resumed = launch(cwd, ["run", "--resume", runId, "--json"])

      expect(resumed.status).toBe(1)
      expect(JSON.parse(resumed.stdout)).toMatchObject({ _tag: "Terminal", runId, status: "failed" })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /**
   * The `--json` stdout contract for the verb the smoke caught breaking it.
   *
   * `smithers up hello -d --json` wrote 1773 bytes to stdout and none to
   * stderr: a runtime `WARN` block first and the receipt last, so a pipeline
   * parsing the document read a syntax error. `bin.ts` provides
   * `Logger.LogToStderr` for exactly that; this holds the detached shape to it.
   */
  it("writes one JSON document and nothing else to stdout when detached", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "-d", "--json"])

      expect(launched.status).toBe(0)
      expect(launched.stdout.trimEnd().split("\n")).toHaveLength(1)
      const receipt = JSON.parse(launched.stdout) as { readonly detached?: unknown; readonly runId?: unknown }
      expect(receipt.detached).toBe(true)
      expect(receipt.runId).toMatch(/^run-/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("exits 1 from `run` too, which is the same attached launch", () => {
    const cwd = stageUnservableSeat()
    try {
      const planned = launch(cwd, ["plan", "failing", "--json"])
      expect(planned.status).toBe(0)
      const approval = JSON.stringify(
        (JSON.parse(planned.stdout) as { readonly approval: unknown }).approval
      )
      expect(launch(cwd, ["approve", approval, "--scope", "run", "--json"]).status).toBe(0)

      const launched = launch(cwd, ["run", approval, "--json"])

      expect(launched.status).toBe(1)
      expect(launched.stdout.trimEnd().split("\n")).toHaveLength(1)
      expect((JSON.parse(launched.stdout) as { readonly runId?: unknown }).runId).toMatch(/^run-/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * The project `smithers init` scaffolds, launched exactly as it was written.
 *
 * The Phase 7 verdict at cd14388ed7 ran the two commands the scaffold's own
 * doc comment promises — `smithers init hello`, then `smithers up hello` in
 * that directory — and got exit 1 with `Run run-1 was accepted but the
 * executor did not take it`, a `control.db` row still `accepted` under
 * `ownerId {pid: 0}`, an `engine.db` with no row at all, and
 * `smithers status run-1` answering forever. Only `smithers cancel` ended it.
 *
 * Nothing here stubs the seat: the scaffold is generated by the real binary
 * and launched by the real binary over real SQLite files.
 */
describe("the smithers init scaffold, launched as written", processBudget, () => {
  /** The provider credentials a scaffold reads, and the refusal reads back. */
  const seatVariables = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "CEREBRAS_API_KEY",
    "SMITHERS_OPENAI_AUTH",
    "FLOWS_OPENAI_AUTH"
  ]

  /**
   * This process's environment with every provider credential removed.
   *
   * The maintainer's shell exports some of these, so a case that inherited the
   * environment would prove nothing on one machine and something else on the
   * next.
   */
  const withoutSeats = (): Record<string, string> => {
    const environment: Record<string, string> = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined || seatVariables.includes(name)) continue
      environment[name] = value
    }
    return environment
  }

  /** An empty repository: what an operator runs `smithers init` in. */
  const stageEmptyProject = (): string => {
    const cwd = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    mkdirSync(join(cwd, ".git"))
    return cwd
  }

  const smithers = (
    cwd: string,
    args: ReadonlyArray<string>,
    environment: Record<string, string>
  ) =>
    spawnSync(process.execPath, ["--no-warnings", executable, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 600_000,
      env: environment
    })

  /** One run's control row, as the next process finds it on disk. */
  const controlRun = (
    cwd: string,
    runId: string
  ): { status: string; finished_at_ms: number | null } | undefined => {
    const handle = new DatabaseSync(join(cwd, ".flows", "control.db"), { readOnly: true })
    try {
      return handle.prepare(
        "SELECT status, finished_at_ms FROM flows_runs WHERE run_id = ?"
      ).get(runId) as unknown as { status: string; finished_at_ms: number | null } | undefined
    } finally {
      handle.close()
    }
  }

  /** Every run row `engine.db` holds, which for an unlaunched run is none. */
  const engineRunIds = (cwd: string): ReadonlyArray<string> => {
    const file = join(cwd, ".flows", "engine.db")
    if (!existsSync(file)) return []
    const handle = new DatabaseSync(file, { readOnly: true })
    try {
      return (handle.prepare("SELECT run_id FROM flows_runs").all() as unknown as ReadonlyArray<
        { readonly run_id: string }
      >).map((row) => row.run_id)
    } finally {
      handle.close()
    }
  }

  it("writes a seat the host can resolve, chosen from the environment doctor reads", () => {
    const cwd = stageEmptyProject()
    try {
      const environment = { ...withoutSeats(), OPENAI_API_KEY: "sk-not-used-by-init" }

      expect(smithers(cwd, ["init", "hello", "--json"], environment).status).toBe(0)

      const flow = readFileSync(join(cwd, "flows", "hello", "flow.mdx"), "utf8")
      expect(flow).toContain("\nmodel: openai:gpt-5.6-sol\n")
      // The scaffold says which key chose the seat and where to see the rest,
      // as a YAML comment: the markdown body is the agent's instructions.
      expect(flow).toContain("OPENAI_API_KEY")
      expect(flow).toContain("smithers doctor")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("refuses the launch by naming the missing key, and leaves both databases terminal", () => {
    const cwd = stageEmptyProject()
    try {
      const environment = withoutSeats()
      const initialized = smithers(cwd, ["init", "hello", "--json"], environment)
      expect(initialized.status).toBe(0)
      expect(readFileSync(join(cwd, "flows", "hello", "flow.mdx"), "utf8"))
        .toContain("\nmodel: anthropic:claude-sonnet-4-5\n")

      const launched = smithers(cwd, ["up", "hello", "--json"], environment)

      expect(launched.status).toBe(1)
      expect(launched.stderr).toContain(
        "Set ANTHROPIC_API_KEY to run the anthropic:claude-sonnet-4-5 seat"
      )
      // The `--json` contract holds under the refusal: the refusal is a
      // diagnostic and belongs on stderr, so stdout carries no half-written
      // document for a pipeline to choke on.
      expect(launched.stdout).toBe("")

      // The run the refusal is about is over, on disk, in the process that
      // refused it. Before this it stayed `accepted` under an owner with pid
      // 0, and `smithers cancel` was the only way to end it.
      const listed = smithers(cwd, ["ps", "--json"], environment)
      expect(listed.status).toBe(0)
      const runs = (JSON.parse(listed.stdout) as {
        readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string }>
      }).items
      expect(runs).toHaveLength(1)
      const runId = runs[0]!.runId
      expect(runs[0]!.status).toBe("failed")

      const row = controlRun(cwd, runId)
      expect(row?.status).toBe("failed")
      expect(row?.finished_at_ms).not.toBeNull()
      // No engine row was ever created: the executor refused before the engine
      // was handed anything, so there is nothing for a later sweep to reclaim.
      expect(engineRunIds(cwd)).toEqual([])

      // The verbs an operator reaches for next all read it as over.
      const status = smithers(cwd, ["status", runId], environment)
      expect(status.status).toBe(0)
      expect(status.stdout).toContain("failed")
      const swept = smithers(cwd, ["gc", "--older-than", "0s", "--dry-run", "--json"], environment)
      expect(swept.status).toBe(0)
      expect(swept.stdout).toContain(runId)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("is not claimed or re-driven by a later executor boot", () => {
    const cwd = stageEmptyProject()
    try {
      const environment = withoutSeats()
      expect(smithers(cwd, ["init", "hello", "--json"], environment).status).toBe(0)
      expect(smithers(cwd, ["up", "hello", "--json"], environment).status).toBe(1)
      const runId = (JSON.parse(smithers(cwd, ["ps", "--json"], environment).stdout) as {
        readonly items: ReadonlyArray<{ readonly runId: string }>
      }).items[0]!.runId
      const settled = controlRun(cwd, runId)

      // A second `smithers` over the same `.flows` composes its own executor,
      // exactly as every local verb does, and sweeps for stale rows as it
      // boots.
      const second = smithers(cwd, ["up", "hello", "--json"], environment)
      expect(second.status).toBe(1)

      expect(controlRun(cwd, runId)).toEqual(settled)
      expect(engineRunIds(cwd)).toEqual([])
      const runs = (JSON.parse(smithers(cwd, ["ps", "--json"], environment).stdout) as {
        readonly items: ReadonlyArray<{ readonly runId: string; readonly status: string }>
      }).items
      expect(runs.map((entry) => entry.status)).toEqual(["failed", "failed"])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * The same two commands against a funded seat.
 *
 * This is the claim `smithers init`'s own doc comment makes — "`smithers up
 * <name>` works in the directory `init` just created" — and the only way to
 * hold it is to run the scaffolded prompt on a real provider. It costs a real
 * agent run of three to four minutes, so it runs only where the ChatGPT seat
 * the CLI suite already stages is actually signed in: export
 * `SMITHERS_OPENAI_AUTH=chatgpt` after `codex login` to take it.
 */
const chatgptSeat = process.env["SMITHERS_OPENAI_AUTH"] === "chatgpt" &&
  existsSync(CodexAuth.locate(process.env))

describe.skipIf(!chatgptSeat)("the smithers init scaffold on a funded seat", { timeout: 900_000 }, () => {
  it("runs to completed, from `init` to a terminal row in both databases", () => {
    const cwd = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    // A real repository, not a bare `.git` directory: the engine snapshots the
    // workspace through `jj`, which refuses a directory that looks like a git
    // repository and is not one.
    expect(spawnSync("git", ["init", "--quiet"], { cwd, encoding: "utf8" }).status).toBe(0)
    try {
      const environment = { ...process.env } as Record<string, string>
      const initialized = spawnSync(process.execPath, ["--no-warnings", executable, "init", "hello", "--json"], {
        cwd,
        encoding: "utf8",
        timeout: 600_000,
        env: environment
      })
      expect(initialized.status).toBe(0)
      expect((JSON.parse(initialized.stdout) as { readonly seat: string }).seat).toBe("openai:gpt-5.6-sol")

      const launched = spawnSync(process.execPath, ["--no-warnings", executable, "up", "hello", "--json"], {
        cwd,
        encoding: "utf8",
        timeout: 800_000,
        env: environment
      })

      expect(launched.status).toBe(0)
      const runId = (JSON.parse(launched.stdout) as { readonly runId: string }).runId
      for (const database of ["control.db", "engine.db"]) {
        const handle = new DatabaseSync(join(cwd, ".flows", database), { readOnly: true })
        try {
          const row = handle.prepare(
            "SELECT status, finished_at_ms FROM flows_runs WHERE run_id = ?"
          ).get(runId) as unknown as { status: string; finished_at_ms: number | null }
          expect(row.status, database).toBe("completed")
          expect(row.finished_at_ms, database).not.toBeNull()
        } finally {
          handle.close()
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * What `smithers signal` tells an operator when the run is parked on something
 * else.
 *
 * The Phase 7 smoke ran `smithers signal run-3 '{"name":"go", ...}'` against a
 * run parked on a 150 second timer. It exited 1 with `go: ` on stderr: the
 * refusal declared a `name` field, which shadows `Error.prototype.name`, and
 * declared no message, so `bin.ts` `report` printed the operator's own word
 * followed by nothing (defect D3).
 *
 * The park is written onto the two databases rather than driven, because
 * parking a real run needs a model turn and this host has no provider. The
 * rows are the ones a timer park leaves: `suspended` with `waiting_reason`
 * `timer` and a deadline still ahead, on both the engine row and the control
 * summary.
 */
describe("smithers signal against a run parked on something else", processBudget, () => {
  const parkOnTimer = (cwd: string, runId: string): void => {
    const wakeAtMs = Date.now() + 150_000
    const engine = new DatabaseSync(join(cwd, ".flows", "engine.db"))
    try {
      engine.prepare(
        `UPDATE flows_runs SET status = 'suspended', waiting_reason = 'timer', waiting_wake_at_ms = ?,
           finished_at_ms = NULL, owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL,
           heartbeat_at_ms = NULL, claim_host_id = NULL, claim_pid = NULL, claim_nonce = NULL,
           claimed_at_ms = NULL, state_json = json_remove(state_json, '$.result')
         WHERE run_id = ?`
      ).run(wakeAtMs, runId)
    } finally {
      engine.close()
    }
    const control = new DatabaseSync(join(cwd, ".flows", "control.db"))
    try {
      // The control run's status lives in the summary document, which is what
      // `SqlControlRuntime.getRun` parses.
      control.prepare(
        `UPDATE flows_runs SET status = 'suspended', waiting_reason = 'timer', waiting_wake_at_ms = ?,
           finished_at_ms = NULL, owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL,
           heartbeat_at_ms = NULL, state_json = json_set(state_json, '$.status', 'suspended')
         WHERE run_id = ?`
      ).run(wakeAtMs, runId)
    } finally {
      control.close()
    }
  }

  it("names the refusal and says what is open, instead of echoing the signal's name", () => {
    const cwd = stageUnservableSeat()
    try {
      const launched = launch(cwd, ["up", "failing", "--json"])
      expect(launched.status).toBe(1)
      const runId = (JSON.parse(launched.stdout) as { readonly runId: string }).runId
      parkOnTimer(cwd, runId)

      const signalled = launch(cwd, ["signal", runId, JSON.stringify({ name: "go", payload: {} })])

      expect(signalled.status).toBe(1)
      expect(signalled.stderr.trimEnd()).toBe(
        `NoMatchingWait: no wait point named "go" is open on run ${runId}. ` +
          `Read \`smithers status ${runId}\` to see what that run is waiting for.`
      )
      // Nothing was written where the document goes.
      expect(signalled.stdout).toBe("")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
