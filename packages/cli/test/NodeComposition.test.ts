/**
 * The Node composition root: argument and environment configuration, the
 * durable local stack the `flows` process actually assembles, the output layer
 * that transfers a rendered status to the process exit code, and the server
 * binds that must stay confined to loopback.
 */
import { NodeServices } from "@effect/platform-node"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import { Control as ControlService } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Path from "@smthrs/kernel/Path"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Registry } from "@smthrs/registry"
import * as Container from "@smthrs/std/Container"
import { Cause, Effect, Exit, FileSystem, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { existsSync } from "node:fs"
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as ExecutorOwnership from "../src/ExecutorOwnership.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"

let root = ""

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "flows-cli-composition-"))
})

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true })
})

describe("NodeControl.makeConfig", () => {
  it("resolves nothing from an empty invocation and an empty environment", () => {
    expect(NodeControl.makeConfig([], {})).toEqual({ remote: undefined, credential: undefined })
  })

  it("falls back to the environment only when the flag is absent", () => {
    expect(NodeControl.makeConfig([], { FLOWS_REMOTE: "https://env.example.test" })).toEqual({
      remote: "https://env.example.test",
      credential: undefined
    })
    expect(
      NodeControl.makeConfig(["--remote", "https://flag.example.test"], { FLOWS_REMOTE: "https://env.example.test" })
    ).toEqual({ remote: "https://flag.example.test", credential: undefined })
  })

  it("treats `--remote` as the last argument as no value at all", () => {
    // There is no argument after it, so the flag contributes nothing and the
    // environment fallback still applies.
    expect(NodeControl.makeConfig(["--remote"], { FLOWS_REMOTE: "https://env.example.test" })).toEqual({
      remote: "https://env.example.test",
      credential: undefined
    })
  })

  it("keeps an explicitly empty `--remote=` instead of falling back", () => {
    // `??` only falls back on absence, and an empty inline value is a present
    // empty string.
    expect(NodeControl.makeConfig(["--remote="], { FLOWS_REMOTE: "https://env.example.test" })).toEqual({
      remote: "",
      credential: undefined
    })
  })

  it("takes the first occurrence when a flag is repeated", () => {
    expect(NodeControl.makeConfig(["--remote", "https://first.test", "--remote", "https://second.test"], {}))
      .toEqual({ remote: "https://first.test", credential: undefined })
  })

  it("does not guess that a following flag is a missing value", () => {
    // Positional reading is deliberate and each flag is scanned on its own:
    // the token after `--remote` is its value whatever it looks like, and
    // `--credential` is still found where it stands.
    expect(NodeControl.makeConfig(["--remote", "--credential", "secret"], {})).toEqual({
      remote: "--credential",
      credential: "secret"
    })
  })

  it("resolves a credential with no remote at all", () => {
    expect(NodeControl.makeConfig(["--credential=secret"], {})).toEqual({
      remote: undefined,
      credential: "secret"
    })
  })

  it("does not treat a longer flag with the same prefix as a match", () => {
    expect(NodeControl.makeConfig(["--remotely", "x"], {})).toEqual({ remote: undefined, credential: undefined })
  })
})

describe("NodeControl.config", () => {
  it("reads the current process arguments and environment", () => {
    const argv = process.argv
    const previous = process.env.FLOWS_REMOTE
    try {
      process.argv = [process.execPath, "flows", "--credential=from-argv"]
      process.env.FLOWS_REMOTE = "https://from-environment.test"
      expect(Effect.runSync(NodeControl.config)).toEqual({
        remote: "https://from-environment.test",
        credential: "from-argv"
      })
    } finally {
      process.argv = argv
      if (previous === undefined) delete process.env.FLOWS_REMOTE
      else process.env.FLOWS_REMOTE = previous
    }
  })
})

describe("NodeControl database locations", () => {
  it("keeps the control plane and the execution engine in separate files", () => {
    expect(NodeControl.databasePath("/work")).toBe(join("/work", ".flows", "control.db"))
    expect(NodeControl.executionDatabasePath("/work")).toBe(join("/work", ".flows", "engine.db"))
    expect(NodeControl.databasePath("/work")).not.toBe(NodeControl.executionDatabasePath("/work"))
  })
})

describe("NodeControl.checkpointStore", () => {
  it("pins on the workspace, under both the names a container gives it", () => {
    // One directory, two names. The host checks a checkpoint out under the
    // workspace and the container reaches the same directory through the mount
    // it already has — which is why the scratch lives inside the workspace at
    // all, and why the store needs both paths.
    expect(NodeControl.checkpointStore({ FLOWS_TEST_CWD: "/testbed" }, "/work/repo")).toEqual({
      root: "/work/repo",
      cwd: "/testbed"
    })
  })

  it("still pins for a host that runs its own tree directly", () => {
    // No container, so the two names of the one directory are the same name.
    // A host that declares nothing still gets checkpoints; it is the workspace
    // root that decides, not the container.
    for (const environment of [{}, { FLOWS_TEST_CWD: "" }, { FLOWS_TEST_CWD: "  " }]) {
      expect(NodeControl.checkpointStore(environment, "/work/repo")).toEqual({ root: "/work/repo" })
    }
  })
})

describe("NodeControl.testRunner", () => {
  it("declares no runner until the host names a command", () => {
    // A `test` flow bound over a declaration that can only refuse is worse than
    // no flow at all: the catalog then advertises a call whose every answer is
    // "not configured", and a run spends a frame finding that out.
    expect(NodeControl.testRunner({}, "/work")).toBeUndefined()
    expect(NodeControl.testRunner({ FLOWS_TEST_COMMAND: "   " }, "/work")).toBeUndefined()
  })

  it("reads the runner, its container and its two directories off the environment", () => {
    // The container path and the host path are the same tree under two names:
    // the runner runs at `cwd` inside the container, and a baseline worktree is
    // checked out from `root` on the host.
    expect(
      NodeControl.testRunner(
        {
          FLOWS_TEST_COMMAND: "./tests/runtests.py --settings=test_sqlite",
          FLOWS_TEST_CONTAINER: "swebench-1",
          FLOWS_TEST_CWD: "/testbed",
          FLOWS_TEST_TIMEOUT_MS: "600000"
        },
        "/work/repo"
      )
    ).toEqual({
      command: "./tests/runtests.py --settings=test_sqlite",
      container: "swebench-1",
      cwd: "/testbed",
      root: "/work/repo",
      timeoutMs: 600_000
    })
  })

  it("defaults the runner's directory to the repository and drops an unusable timeout", () => {
    expect(NodeControl.testRunner({ FLOWS_TEST_COMMAND: "pytest -q" }, "/work/repo")).toEqual({
      command: "pytest -q",
      cwd: "/work/repo",
      root: "/work/repo"
    })
    for (const timeout of ["", "soon", "0", "-1"]) {
      expect(
        NodeControl.testRunner({ FLOWS_TEST_COMMAND: "pytest -q", FLOWS_TEST_TIMEOUT_MS: timeout }, "/work/repo")
      ).not.toHaveProperty("timeoutMs")
    }
  })

  it("offers the `test` flow to a run exactly when a runner was declared", async () => {
    // The r91 finding about this flow is not that it was wrong, it is that no
    // composition offered it: 45 graded runs, zero `test` calls, while the cell
    // contract's doctrine assumed the call existed. Everything else about the
    // flow was already covered, so this is the assertion that was missing —
    // the declaration decides, and what it decides is what `ctx.flows` lists.
    const names = await Effect.runPromise(
      Effect.gen(function*() {
        const services = yield* Effect.context<
          KernelChildProcessSpawner.ChildProcessSpawner | Path.Path
        >()
        const container = Container.makeCommand()
        expect(NodeControl.testFlows(services, container, undefined)).toEqual([])
        const offered = NodeControl.testFlows(
          services,
          container,
          NodeControl.testRunner({ FLOWS_TEST_COMMAND: "pytest -q", FLOWS_TEST_CONTAINER: "swebench-1" }, "/work/repo")
        )
        const bound = yield* Effect.forEach(offered, (source) => source.bindings())
        return bound.flat().map((binding) => binding.descriptor.name)
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.orDie
      ) as Effect.Effect<ReadonlyArray<string>>
    )
    expect(names).toEqual(["test"])
  })
})

describe("NodeControl.layerRegistry failures", () => {
  it("dies on a source root that exists but cannot be scanned", async () => {
    const broken = await mkdtemp(join(tmpdir(), "flows-cli-broken-"))
    try {
      // A file where the `flows/` directory belongs is a real misconfiguration,
      // and it must not be mistaken for "this project has no flows".
      await writeFile(join(broken, "flows"), "not a directory")
      const exit = await Effect.runPromise(
        Effect.exit(
          Effect.flatMap(Registry.Registry, (registry) => registry.list()).pipe(
            Effect.provide(NodeControl.layerRegistry(broken)),
            Effect.scoped
          )
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(String(Cause.squash(exit.cause))).toContain("is not a directory")
      }
    } finally {
      await rm(broken, { recursive: true, force: true })
    }
  })
})

describe("NodeControl.engineDurable with a registry", () => {
  it("knows every discovered project flow as well as the reserved catalog", async () => {
    const project = await mkdtemp(join(tmpdir(), "flows-cli-discovered-"))
    try {
      await mkdir(join(project, "flows", "review"), { recursive: true })
      await writeFile(
        join(project, "flows", "review", "SKILL.md"),
        ["---", "description: Reviews a proposed change.", "---", "", "# Review", ""].join("\n")
      )
      const registry = NodeControl.layerRegistry(project)
      const engine = NodeControl.engineDurable(project, registry)
      const planned = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* ControlService.Control
          const discovered = yield* control.plan({ flowId: "review", input: {} })
          const reserved = yield* control.plan({ flowId: "system/test", input: {} })
          return { discovered: discovered.flowId, reserved: reserved.flowId }
        }).pipe(
          Effect.provide(
            Application.layer({}, registry, engine) as Layer.Layer<ControlService.Control>
          ),
          Effect.scoped,
          Effect.orDie
        )
      )

      // Without the registry the durable runtime knew only the reserved
      // catalog, so a project flow planned as `FlowNotFound`.
      expect(planned).toEqual({ discovered: "review", reserved: "system/test" })
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })
})

describe("NodeControl.layerObserver", () => {
  it("measures the workspace on the host platform, not through the kernel's guard", async () => {
    const observed = await mkdtemp(join(tmpdir(), "flows-cli-observer-"))
    try {
      await writeFile(join(observed, "a.py"), "one")
      // A hard link is the discriminator: the kernel refuses a hard-linked
      // regular file outright, so a guarded observer measures neither name.
      // The measurement wants both — an edit through either moves the tree —
      // and the walk that gets them is the one that never opens a file, never
      // follows a link, and never leaves the root it was given.
      await link(join(observed, "a.py"), join(observed, "b.py"))

      const measurement = await Effect.runPromise(
        Effect.flatMap(WorkspaceObservation.Observer, (observer) => observer.observe).pipe(
          Effect.provide(NodeControl.layerObserver(observed)),
          Effect.scoped,
          Effect.orDie
        )
      )

      expect(measurement.paths).toBe(2)
      expect(measurement.complete).toBe(true)

      // The discriminator is real rather than assumed: the same `stat` through
      // the guarded platform is refused, and finding that out costs one helper
      // process per path.
      const refused = await Effect.runPromise(
        Effect.exit(
          Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.stat(join(observed, "a.py"))).pipe(
            Effect.provide(NodeControl.layerGuardedPlatform(observed)),
            Effect.scoped
          )
        )
      )

      expect(Exit.isFailure(refused)).toBe(true)
    } finally {
      await rm(observed, { recursive: true, force: true })
    }
  })

  it("leaves the guarded filesystem in place for everything composed beside it", async () => {
    const observed = await mkdtemp(join(tmpdir(), "flows-cli-observer-beside-"))
    try {
      await writeFile(join(observed, "a.py"), "one")
      await link(join(observed, "a.py"), join(observed, "b.py"))

      // `layerExecutor` provides the observer in the same array as the guarded
      // platform, and `StandardFlows.filesystem` then reads `FileSystem` out of
      // that context. The observer runs on the host platform, so this is the
      // question the seam turns on: does the host `FileSystem` it was built
      // from escape into the context the agent-reachable flows resolve from?
      // It must not — that would unguard every tool that opens a file. The hard
      // link is the discriminator again, in the opposite direction.
      const beside = Layer.mergeAll(
        NodeControl.layerGuardedPlatform(observed),
        NodeControl.layerObserver(observed)
      )
      const [measurement, stat] = await Effect.runPromise(
        Effect.all([
          Effect.flatMap(WorkspaceObservation.Observer, (observer) => observer.observe).pipe(Effect.orDie),
          Effect.exit(Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.stat(join(observed, "a.py"))))
        ]).pipe(Effect.provide(beside), Effect.scoped)
      )

      expect(measurement.paths).toBe(2)
      expect(Exit.isFailure(stat)).toBe(true)
    } finally {
      await rm(observed, { recursive: true, force: true })
    }
  })

  it("asks the grant store the caller supplied, not a default one", async () => {
    const observed = await mkdtemp(join(tmpdir(), "flows-cli-observer-grants-"))
    try {
      await writeFile(join(observed, "a.py"), "one")

      // `layerExecutor` builds one grant store and hands it to both the kernel
      // filesystem and the kernel spawner. A `layerGuardedPlatform` that pinned
      // its own store would leave a composition whose shell is authorized and
      // whose filesystem is not, which no type would catch. A real store with
      // no rules and nobody to ask authorizes nothing, so the same read that
      // the default allow-all store permits is refused when this one is passed
      // instead.
      const read = (grants?: Layer.Layer<GrantStore.GrantStore>) =>
        Effect.runPromise(
          Effect.exit(
            Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(join(observed, "a.py")))
              .pipe(
                Effect.provide(NodeControl.layerGuardedPlatform(observed, grants)),
                Effect.scoped
              )
          )
        )
      const ruleless = Layer.orDie(GrantStore.layer({ attended: false, rules: [] })).pipe(
        Layer.provide(Workspace.layer(observed))
      )

      expect(Exit.isSuccess(await read())).toBe(true)
      expect(Exit.isFailure(await read(ruleless))).toBe(true)
    } finally {
      await rm(observed, { recursive: true, force: true })
    }
  })
})

describe("NodeControl.layerOutput", () => {
  it("transfers each rendered status to the process exit code", async () => {
    const previous = process.exitCode
    try {
      const codes = await Effect.runPromise(
        Effect.gen(function*() {
          const output = yield* Output.Output
          const parked = yield* output.render({ _tag: "Parked" }, "json")
          const parkedCode = process.exitCode
          const accepted = yield* output.render({ _tag: "Accepted" }, "human")
          return { parked, parkedCode, accepted, acceptedCode: process.exitCode }
        }).pipe(Effect.provide(NodeControl.layerOutput))
      )

      // The rendered text is unchanged by the transfer, and the last render
      // wins the process status.
      expect(codes.parked.text).toBe("{\"_tag\":\"Parked\"}")
      expect(codes.parkedCode).toBe(3)
      expect(codes.accepted.text).toBe("{\n  \"_tag\": \"Accepted\"\n}")
      expect(codes.acceptedCode).toBe(0)
    } finally {
      process.exitCode = previous
    }
  })
})

describe("NodeControl.layer", () => {
  it("assembles the local stack over the working directory, executor included", async () => {
    const previousCwd = process.cwd()
    const previousExit = process.exitCode
    const project = join(root, "local-stack")
    await mkdir(project, { recursive: true })
    try {
      process.chdir(project)
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* ControlService.Control
          const output = yield* Output.Output
          const card = yield* control.plan({ flowId: "system/test", input: {} })
          const rendered = yield* output.render(card, "json")
          const ownsExecutor = yield* ExecutorOwnership.ExecutorOwnership
          return { flowId: card.flowId, ownsExecutor, rendered: rendered.text.length }
        }).pipe(
          Effect.provide(NodeControl.layer({})),
          Effect.scoped,
          Effect.orDie
        )
      )

      // A local composition owns its executor — that fact is what makes the
      // command wait for a run it started to settle.
      expect(result.flowId).toBe("system/test")
      expect(result.ownsExecutor).toBe(true)
      expect(result.rendered).toBeGreaterThan(0)
      // Both databases live under the working directory the process was
      // started in, and each composition creates its own.
      expect(existsSync(NodeControl.databasePath(project))).toBe(true)
      expect(existsSync(NodeControl.executionDatabasePath(project))).toBe(true)
    } finally {
      process.chdir(previousCwd)
      process.exitCode = previousExit
    }
  }, 60_000)

  it("does not own an executor when the command targets a remote", async () => {
    const ownsExecutor = await Effect.runPromise(
      ExecutorOwnership.ExecutorOwnership.pipe(
        Effect.provide(NodeControl.layerControl({ remote: "http://127.0.0.1:1" })),
        Effect.scoped
      )
    )

    expect(ownsExecutor).toBe(false)
  })
})

describe("NodeControl server binds", () => {
  it("defaults an options record with no host to loopback", async () => {
    const hostname = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        return server.address._tag === "TcpAddress" ? server.address.hostname : ""
      }).pipe(
        Effect.provide(NodeControl.layerServerNoopAuth({ port: 0 }).pipe(Layer.provide(TestControl.layer()))),
        Effect.scoped
      )
    )

    expect(hostname).toBe("127.0.0.1")
  })

  it("accepts the IPv6 loopback under permissive authentication", () => {
    expect(() => NodeControl.layerServerNoopAuth({ host: "::1", port: 0 })).not.toThrow()
  })

  it("refuses a non-loopback bind under permissive authentication whatever --listen says", () => {
    expect(() => NodeControl.layerServerNoopAuth({ host: "0.0.0.0", port: 0 })).toThrow(/permissive authentication/)
    expect(() => NodeControl.layerServerNoopAuth({ host: "0.0.0.0", port: 0, listen: true })).toThrow(
      /permissive authentication/
    )
    expect(() => NodeControl.layerServerNoopAuth({ host: "0.0.0.0", port: 0, listen: false })).toThrow(
      /permissive authentication/
    )
  })

  it.each(
    [
      ["a missing --listen", undefined],
      ["an explicit --listen=false", false]
    ] as const
  )("refuses an authenticated non-loopback bind with %s", (_label, listen) => {
    const auth = { token: "alpha-secret", principal: { id: "alpha", kind: "bearer" as const } }
    expect(() =>
      NodeControl.layerServerBearerAuth(
        auth,
        listen === undefined ? { host: "10.0.0.1", port: 0 } : {
          host: "10.0.0.1",
          port: 0,
          listen
        }
      )
    ).toThrow(/--listen/)
  })

  it("accepts both loopback spellings without an opt-in", () => {
    const auth = { token: "alpha-secret", principal: { id: "alpha", kind: "bearer" as const } }
    expect(() => NodeControl.layerServerBearerAuth(auth, { host: "127.0.0.1", port: 0 })).not.toThrow()
    expect(() => NodeControl.layerServerBearerAuth(auth, { host: "::1", port: 0 })).not.toThrow()
  })
})

describe("Application remote endpoint resolution", () => {
  it("reaches the same endpoint whether or not the remote already names /rpc", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        const address = server.address
        if (address._tag !== "TcpAddress") return yield* Effect.fail(new Error("expected a TCP control server"))
        const base = `http://127.0.0.1:${address.port}`
        const plan = (remote: string) =>
          Effect.flatMap(ControlService.Control, (control) => control.plan({ flowId: "system/test", input: {} })).pipe(
            Effect.provide(NodeControl.layerControl({ remote }))
          )
        const bare = yield* plan(base)
        const suffixed = yield* plan(`${base}/rpc`)
        const trailing = yield* plan(`${base}/`)
        return [bare.flowId, suffixed.flowId, trailing.flowId]
      }).pipe(
        Effect.provide(
          NodeControl.layerServerNoopAuth({ host: "127.0.0.1", port: 0 }).pipe(
            Layer.provide(TestControl.layer({ now: () => 0 }))
          )
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer)
      )
    )

    // An operator who pastes the RPC URL and one who pastes the origin must
    // land on the same endpoint rather than on `/rpc/rpc`.
    expect(results).toEqual(["system/test", "system/test", "system/test"])
  })
})
