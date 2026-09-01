import { NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"

const platform = { os: "linux", arch: "x64", libc: null }

/**
 * The runtime layer every manager construction runs over.
 *
 * The manager takes the platform from this service rather than from its own
 * options, so a test that builds a manager has to provide one.
 */
const runtimeLayer = Runtime.layerNoop("node", {
  requirement: ">=22.19.0",
  version: "24.9.0",
  platform
})

/**
 * The same runtime, on a Windows host.
 *
 * The manager reads `platform.os` from this service to decide which name rule
 * the ambient environment is held to, so a Windows-only rule needs a Windows
 * runtime rather than a Windows machine.
 */
const windowsRuntimeLayer = Runtime.layerNoop("node", {
  requirement: ">=22.19.0",
  version: "24.9.0",
  platform: { os: "win32", arch: "x64", libc: null }
})

const withFixture = async <A>(name: string, use: (root: string) => Promise<A>): Promise<A> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), `smthrs-${name}-`)))
  try {
    return await use(root)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}

const writeExecutable = async (path: string, body: string): Promise<void> => {
  await Fs.writeFile(path, `#!/usr/bin/env node\n${body}\n`, "utf8")
  await Fs.chmod(path, 0o755)
}

const makePnpm = (projectRoot: string, executable: string, options: {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
} = {}) =>
  Effect.runPromise(
    PackageManager.makePnpm({
      requirement: "11.21.0",
      projectRoot,
      executable,
      environment: options.environment ?? process.env,
      timeoutMs: options.timeoutMs
    }).pipe(Effect.provide(NodeServices.layer), Effect.provide(runtimeLayer))
  )

describe("PackageManager.storeRoot", () => {
  it("is the fixed .flows store root", () => {
    expect(PackageManager.storeRoot).toBe(".flows/store")
  })

  it("gives every manager a fixed store directory below it", () => {
    for (const name of ["pnpm", "bun"] as const) {
      expect(
        PackageManager.makeNoop(name, { requirement: "11.21.0", projectRoot: "/workspace" }, platform).storeDirectory
      ).toBe(
        `.flows/store/${name}`
      )
    }
  })

  it("keeps unsupported manager metadata truthful", async () => {
    const bun = await Effect.runPromise(
      PackageManager.makeBun({ requirement: "11.21.0", projectRoot: "/workspace" }).pipe(Effect.provide(runtimeLayer))
    )
    expect(bun.lockfileName).toBe("bun.lock")
    await expect(Effect.runPromise(bun.fetch)).rejects.toThrow(/no bun implementation/)
    expect(
      PackageManager.makeNoop("pnpm", { requirement: "11.21.0", projectRoot: "/workspace" }, platform).lockfileName
    ).toBe(
      "pnpm-lock.yaml"
    )
  })

  it("validates manager construction options before exposing a service", () => {
    expect(() => PackageManager.makeNoop("bun", { requirement: "11.21.0", projectRoot: "relative" }, platform))
      .toThrow(/absolute path/)
    expect(() =>
      PackageManager.makeNoop("bun", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        timeoutMs: 0
      }, platform)
    ).toThrow(/timeout must be an integer/)
    expect(() =>
      PackageManager.makeNoop("bun", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        environment: { Path: "one", PATH: "two" }
      }, { ...platform, os: "win32" })
    ).toThrow(/case-insensitive name/)
  })

  /**
   * `layerPackageManager` hands these options the host's own `process.env`. A
   * Windows runner's environment carries names the POSIX convention never
   * produces: `ProgramFiles(x86)` and `CommonProgramFiles(x86)` are set by
   * Windows itself on every 64-bit image. The record is a lookup source, not a
   * set of declarations, so refusing it because the operating system named a
   * variable the way it always has is a build that cannot run.
   */
  it("accepts the environment names a Windows host sets for itself", () => {
    expect(() =>
      PackageManager.makeNoop("pnpm", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        environment: {
          Path: "C:\\Windows",
          "ProgramFiles(x86)": "C:\\Program Files (x86)",
          "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files"
        }
      }, { ...platform, os: "win32" })
    ).not.toThrow()
  })

  /**
   * Windows still has a name rule, and it is the environment block's own: a
   * name is non-empty and carries neither `=` nor a control character, because
   * `NAME=VALUE` entries separated by NUL are all the block can represent. A
   * name the block cannot carry fails here rather than reaching a spawn.
   */
  it("refuses a name a Windows environment block cannot carry", () => {
    for (const name of ["A=B", "", "A\u0007B"]) {
      expect(() =>
        PackageManager.makeNoop("pnpm", {
          requirement: "11.21.0",
          projectRoot: "/workspace",
          environment: { [name]: "x" }
        }, { ...platform, os: "win32" })
      ).toThrow(/environment name is not portable/)
    }
  })

  /** Off Windows the portable name rule is unchanged. */
  it("keeps the portable name rule on a POSIX host", () => {
    expect(() =>
      PackageManager.makeNoop("pnpm", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        environment: { "ProgramFiles(x86)": "C:\\Program Files (x86)" }
      }, platform)
    ).toThrow(/package-manager environment name is not portable: "ProgramFiles\(x86\)"/)
  })

  it("does not invoke user string conversion while rejecting an invalid timeout", () => {
    let calls = 0
    const timeout = {
      toString: () => {
        calls += 1
        return "0"
      }
    }
    expect(() =>
      PackageManager.makeNoop("bun", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        timeoutMs: timeout as never
      }, platform)
    ).toThrow(/received object/)
    expect(calls).toBe(0)
  })

  it("rejects accessors, proxies, unknown fields, and malformed environment values", () => {
    let reads = 0
    const accessor = Object.defineProperty({ requirement: "11.21.0" }, "projectRoot", {
      enumerable: true,
      get: () => {
        reads += 1
        return "/workspace"
      }
    })
    expect(() => PackageManager.makeNoop("bun", accessor as never, platform)).toThrow(/data property/)
    expect(reads).toBe(0)
    expect(() =>
      PackageManager.makeNoop(
        "bun",
        new Proxy({ requirement: "11.21.0", projectRoot: "/workspace" }, {
          ownKeys: () => {
            throw new Error("trap")
          }
        }),
        platform
      )
    ).toThrow(/inspected safely/)
    expect(() =>
      PackageManager.makeNoop("bun", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        typo: true
      } as never, platform)
    ).toThrow(/unknown property "typo"/)
    expect(() =>
      PackageManager.makeNoop("bun", {
        requirement: "11.21.0",
        projectRoot: "/workspace",
        environment: { TOKEN: 42 } as never
      }, platform)
    ).toThrow(/must be a string or undefined/)
  })

  it("snapshots options and environment before exposing a service", async () => {
    await withFixture("package-manager-options-snapshot", async (root) => {
      const other = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-mutated-root-"))
      try {
        const executable = NodePath.join(root, "pnpm.mjs")
        await Fs.writeFile(NodePath.join(root, ".npmrc"), "token=${NPM_TOKEN}\n", "utf8")
        await writeExecutable(
          executable,
          "process.stdout.write(`${process.cwd()}|${process.env.NPM_TOKEN}\\n`)"
        )
        const environment: Record<string, string | undefined> = {
          NPM_TOKEN: "original",
          PATH: process.env.PATH
        }
        const options = {
          requirement: "11.21.0",
          projectRoot: root,
          executable,
          environment
        }
        const manager = await Effect.runPromise(
          PackageManager.makePnpm(options).pipe(
            Effect.provide(NodeServices.layer),
            Effect.provide(runtimeLayer)
          )
        )
        options.projectRoot = other
        environment.NPM_TOKEN = "mutated"

        expect(await Effect.runPromise(manager.version)).toBe(`${root}|original`)
        expect(manager.projectRoot).toBe(root)
        expect(manager.requirement).toBe("11.21.0")
      } finally {
        await Fs.rm(other, { recursive: true, force: true })
      }
    })
  })

  it("strictly validates canonical store and linked-tree manifest inputs", async () => {
    const digest = "0".repeat(64) as PackageManager.Digest
    const alternate = "1".repeat(64) as PackageManager.Digest
    const valid = {
      manager: "pnpm" as const,
      managerVersion: "10.10.0",
      platform,
      lockfileDigest: digest,
      npmrcDigest: null
    }
    expect(PackageManager.storeManifestText(valid)).toContain("smithers-build/store-manifest/v1")
    expect(() => PackageManager.storeManifestText({ ...valid, npmrcDigest: undefined as never })).toThrow(
      /SHA-256 digest or null/
    )
    expect(() => PackageManager.storeManifestText({ ...valid, lockfileDigest: "A".repeat(64) })).toThrow(
      /lowercase SHA-256 digest/
    )
    expect(() => PackageManager.storeManifestText({ ...valid, extra: true } as never)).toThrow(
      /unknown property "extra"/
    )

    let reads = 0
    const accessor = Object.defineProperty({ ...valid }, "managerVersion", {
      enumerable: true,
      get: () => {
        reads += 1
        return "10.10.0"
      }
    })
    expect(() => PackageManager.storeManifestText(accessor)).toThrow(/data property/)
    expect(reads).toBe(0)

    await expect(Effect.runPromise(
      PackageManager.linkedTreeManifest({
        storeDigest: digest,
        packageJsonDigest: alternate,
        managerEvidence: undefined as never
      }).pipe(Effect.provide(NodeServices.layer))
    )).rejects.toThrow(/lowercase SHA-256 digests/)
  })

  it("snapshots and freezes store manifest identity while hashing", async () => {
    const digest = "0".repeat(64) as PackageManager.Digest
    const mutablePlatform = { ...platform }
    const input = {
      manager: "pnpm" as const,
      managerVersion: "10.10.0",
      platform: mutablePlatform,
      lockfileDigest: digest,
      npmrcDigest: null
    }
    const resultPromise = Effect.runPromise(
      PackageManager.storeManifest(input).pipe(Effect.provide(NodeServices.layer))
    )
    input.managerVersion = "99.0.0"
    mutablePlatform.arch = "arm64"
    const result = await resultPromise
    expect(result.managerVersion).toBe("10.10.0")
    expect(result.platform).toEqual(platform)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.platform)).toBe(true)
    expect(result.digest).toBe(
      await Effect.runPromise(
        PackageManager.storeManifest({
          ...input,
          managerVersion: "10.10.0",
          platform
        }).pipe(Effect.provide(NodeServices.layer), Effect.map((manifest) => manifest.digest))
      )
    )
  })

  it("anchors concurrent manager processes to their own project roots without changing the host cwd", async () => {
    const fixture = await Fs.realpath(
      await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-package-manager-root-"))
    )
    const left = NodePath.join(fixture, "left")
    const right = NodePath.join(fixture, "right")
    const executable = NodePath.join(fixture, "pnpm.mjs")
    await Promise.all([Fs.mkdir(left), Fs.mkdir(right)])
    await Fs.writeFile(
      executable,
      "#!/usr/bin/env node\n" +
        "import { appendFileSync } from \"node:fs\"\n" +
        "appendFileSync(\"calls\", process.cwd() + \"\\n\")\n" +
        "if (process.argv[2] === \"--version\") process.stdout.write(\"9.15.0\\n\")\n",
      "utf8"
    )
    await Fs.chmod(executable, 0o755)
    const original = process.cwd()
    const run = (projectRoot: string) =>
      Effect.runPromise(
        Effect.gen(function*() {
          const manager = yield* PackageManager.makePnpm({
            requirement: "11.21.0",
            projectRoot,
            executable,
            environment: process.env
          })
          expect(manager.projectRoot).toBe(projectRoot)
          expect(yield* manager.version).toBe("9.15.0")
          yield* manager.fetch
        }).pipe(Effect.provide(NodeServices.layer), Effect.provide(runtimeLayer))
      )
    try {
      await Promise.all([run(left), run(right)])
      expect(process.cwd()).toBe(original)
      expect((await Fs.readFile(NodePath.join(left, "calls"), "utf8")).trim().split("\n")).toEqual([left, left])
      expect((await Fs.readFile(NodePath.join(right, "calls"), "utf8")).trim().split("\n")).toEqual([
        right,
        right
      ])
    } finally {
      await Fs.rm(fixture, { recursive: true, force: true })
    }
  })

  it("passes only bootstrap variables and credentials explicitly referenced by .npmrc", async () => {
    await withFixture("package-manager-env", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "//registry.example/:_authToken=${NPM_TOKEN}\n", "utf8")
      await writeExecutable(
        executable,
        "process.stdout.write(JSON.stringify({" +
          "path: process.env.PATH," +
          "token: process.env.NPM_TOKEN," +
          "secret: process.env.UNRELATED_SECRET," +
          "home: process.env.HOME," +
          "userconfig: process.env.NPM_CONFIG_USERCONFIG" +
          "}))"
      )
      const manager = await makePnpm(root, executable, {
        environment: {
          PATH: process.env.PATH,
          HOME: "/hidden/home",
          NPM_TOKEN: "declared-token",
          UNRELATED_SECRET: "must-not-leak"
        }
      })
      const observed = JSON.parse(await Effect.runPromise(manager.version)) as Record<string, unknown>
      expect(observed.path).toBe(process.env.PATH)
      expect(observed.token).toBe("declared-token")
      expect(observed.secret).toBeUndefined()
      expect(observed.home).toBeUndefined()
      expect(observed.userconfig).toBe("/dev/null")
    })
  })

  /**
   * Accepting a Windows name into the lookup source does not put it on a child.
   * Only the bootstrap list and the names a `.npmrc` references are selected
   * from the source, and both are portable by construction, so what the manager
   * spawns with stays a POSIX-named environment on every host.
   */
  it("never forwards a non-portable ambient name into the child environment", async () => {
    await withFixture("package-manager-windows-env", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await writeExecutable(executable, "process.stdout.write(JSON.stringify(Object.keys(process.env)))")
      const manager = await Effect.runPromise(
        PackageManager.makePnpm({
          requirement: "11.21.0",
          projectRoot: root,
          executable,
          environment: {
            Path: process.env.PATH,
            "ProgramFiles(x86)": "C:\\Program Files (x86)",
            "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files"
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.provide(windowsRuntimeLayer))
      )
      const names = JSON.parse(await Effect.runPromise(manager.version)) as ReadonlyArray<string>
      expect(names.filter((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))).toEqual([])
      expect(names).toContain("PATH")
    })
  })

  it("pins pnpm fetch to the canonical project store and non-mutating flags", async () => {
    await withFixture("package-manager-fetch-args", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      const invocation = NodePath.join(root, "invocation.json")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\nwriteFileSync(${
          JSON.stringify(invocation)
        }, JSON.stringify(process.argv.slice(2)))`
      )
      const manager = await makePnpm(root, executable)
      await Effect.runPromise(manager.fetch)
      expect(JSON.parse(await Fs.readFile(invocation, "utf8"))).toEqual([
        "fetch",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--reporter=append-only",
        "--store-dir",
        NodePath.join(root, ".flows/store/pnpm")
      ])
    })
  })

  it("refuses .npmrc references that can mutate the child runtime", async () => {
    await withFixture("package-manager-env-control", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "registry=${NODE_OPTIONS}\n", "utf8")
      await writeExecutable(executable, "process.stdout.write('9.15.0\\n')")
      const manager = await makePnpm(root, executable, {
        environment: { PATH: process.env.PATH, NODE_OPTIONS: "--inspect" }
      })
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(
        /process-control environment variable NODE_OPTIONS/
      )
    })
  })

  it("refuses literal credentials in project configuration before spawning", async () => {
    await withFixture("package-manager-literal-token", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      const marker = NodePath.join(root, "spawned")
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "//registry.example/:_authToken=secret\n", "utf8")
      await writeExecutable(
        executable,
        `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "yes")`
      )
      const manager = await makePnpm(root, executable)
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/embeds a credential/)
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  it("bounds and strictly decodes project configuration before spawning", async () => {
    await withFixture("package-manager-npmrc-bounds", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await writeExecutable(executable, "process.stdout.write('9.15.0\\n')")
      const manager = await makePnpm(root, executable)

      await Fs.writeFile(
        NodePath.join(root, ".npmrc"),
        Buffer.alloc(PackageManager.maximumNpmrcBytes + 1, 0x61)
      )
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/no larger than/)

      await Fs.writeFile(NodePath.join(root, ".npmrc"), Buffer.from([0xff]))
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/not valid UTF-8/)
    })
  })

  it("refuses project inputs that resolve outside the project root", async () => {
    await withFixture("package-manager-outside-input", async (root) => {
      const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-input-"))
      try {
        const executable = NodePath.join(root, "pnpm.mjs")
        const marker = NodePath.join(root, "spawned")
        await writeExecutable(
          executable,
          `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "yes")`
        )
        await Fs.writeFile(NodePath.join(outside, "npmrc"), "registry=https://example.test\n", "utf8")
        await Fs.symlink(NodePath.join(outside, "npmrc"), NodePath.join(root, ".npmrc"))
        const manager = await makePnpm(root, executable)

        await expect(Effect.runPromise(manager.version)).rejects.toThrow(/resolves outside project root/)
        await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
      } finally {
        await Fs.rm(outside, { recursive: true, force: true })
      }
    })
  })

  it("requires a successful, bounded, single-line version response", async () => {
    await withFixture("package-manager-version", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")

      await writeExecutable(executable, "process.exitCode = 23")
      let manager = await makePnpm(root, executable)
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/exited with status 23/)

      await writeExecutable(
        executable,
        `process.stdout.write(Buffer.alloc(${PackageManager.maximumVersionOutputBytes + 1}, 0x61))`
      )
      manager = await makePnpm(root, executable)
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/version output exceeds/)

      await writeExecutable(executable, "process.stdout.write('9.15.0\\nunexpected\\n')")
      manager = await makePnpm(root, executable)
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/more than one line/)

      await writeExecutable(executable, "process.stdout.write(Buffer.from([0xff]))")
      manager = await makePnpm(root, executable)
      await expect(Effect.runPromise(manager.version)).rejects.toThrow(/not valid UTF-8/)
    })
  })

  it("interrupts a package-manager command that exceeds its deadline", async () => {
    await withFixture("package-manager-timeout", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      await writeExecutable(executable, "setInterval(() => {}, 1_000)")
      const manager = await makePnpm(root, executable, { timeoutMs: 100 })
      await expect(Effect.runPromise(manager.fetch)).rejects.toThrow(/did not finish within 100ms/)
    })
  })

  it("kills package-manager descendants when a command times out", async () => {
    await withFixture("package-manager-timeout-tree", async (root) => {
      const executable = NodePath.join(root, "pnpm.mjs")
      const marker = NodePath.join(root, "descendant-survived")
      const child = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes"), 700)`
      await writeExecutable(
        executable,
        "import { spawn } from \"node:child_process\"\n" +
          `spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore" })\n` +
          "setInterval(() => {}, 1_000)"
      )
      const manager = await makePnpm(root, executable, { timeoutMs: 250 })
      await expect(Effect.runPromise(manager.fetch)).rejects.toThrow(/did not finish within 250ms/)
      await new Promise((resolve) => setTimeout(resolve, 850))
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })
})
